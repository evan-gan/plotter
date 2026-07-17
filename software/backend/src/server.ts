// Plotter backend entry point: node:http server exposing the public API
// (queue, gallery, submit/estimate, SSE events), the admin API (plot control,
// machine controls, tuner, calibration), and static hosting of the built
// frontend. No web framework — a small route table over node:http.

import http, { IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import { loadConfig } from "./config";
import { EventBus } from "./events";
import { SerialManager } from "./serial-manager";
import { MachineLock } from "./machine-lock";
import { EtaService } from "./eta";
import { QueueService } from "./queue";
import { GalleryService } from "./gallery";
import { SubmissionService } from "./submissions";
import { WorkerPipeline } from "./pipeline-pool";
import { PlotRefeedService } from "./refeed";
import { PlotRunner } from "./runner";
import { MachineService } from "./machine";
import { TunerService } from "./tuner";
import { sendJson, sendError, readJsonBody, checkAdminPassword, serveStatic } from "./http-util";

type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  admin: boolean;
  handler: RouteHandler;
}

function buildServices() {
  const config = loadConfig();
  const bus = new EventBus();
  const serial = new SerialManager({ simulate: config.simulate, preferredPort: config.serialPort, bus });
  const lock = new MachineLock();
  // Run the CPU-heavy pipeline (optimizer + G-code generation + ETA) on a
  // worker thread so it never blocks the event loop the plot runner and the
  // realtime controls (pause/abort/jog) depend on.
  const pipeline = new WorkerPipeline();
  const eta = new EtaService(serial, pipeline);
  const queue = new QueueService(config.dataDir, () => bus.broadcast({ type: "queueChanged" }));
  const gallery = new GalleryService(config, eta, pipeline);
  const submissions = new SubmissionService(config, eta, queue, pipeline);
  const refeed = new PlotRefeedService(eta, queue, gallery, bus);
  const runner = new PlotRunner(serial, bus, queue, lock);
  const machine = new MachineService(serial, bus, lock, eta, refeed);
  const tuner = new TunerService(serial, bus, lock, refeed);
  return { config, bus, serial, lock, pipeline, eta, queue, gallery, submissions, refeed, runner, machine, tuner };
}

type Services = ReturnType<typeof buildServices>;

/** Declare every API route. Kept declarative so the router stays tiny. */
function buildRoutes(services: Services): Route[] {
  const { config, bus, serial, lock, queue, gallery, submissions, refeed, runner, machine, tuner } = services;
  const routes: Route[] = [];
  const add = (method: string, path: string, admin: boolean, handler: RouteHandler) => {
    const paramNames = [...path.matchAll(/:(\w+)/g)].map((match) => match[1]);
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, "([\\w.-]+)")}$`);
    routes.push({ method, pattern, paramNames, admin, handler });
  };

  // ── public ──
  add("GET", "/api/health", false, (_req, res) => sendJson(res, 200, { ok: true }));

  add("GET", "/api/status", false, async (_req, res) => {
    const machineStatus = serial.isConnected
      ? await machine.status()
      : { connected: false, port: serial.portDescription, state: "Disconnected", mx: 0, my: 0 };
    sendJson(res, 200, {
      machine: machineStatus,
      runner: runner.snapshot(),
      busyWith: lock.busyWith,
      queueLength: queue.pending().length,
      simulated: config.simulate,
      workArea: { widthMm: config.workWidthMm, heightMm: config.workHeightMm },
      paper: {
        shortMm: config.paperShortMm,
        longMm: config.paperLongMm,
        paddingMm: config.paperPaddingMm,
        mirrorX: config.paperMirrorX,
      },
      adminEnabled: Boolean(config.adminPassword),
    });
  });

  add("GET", "/api/events", false, (_req, res) => {
    bus.addClient(res, [
      { type: "serial", connected: serial.isConnected, port: serial.isConnected ? serial.portDescription : null },
      { type: "runnerState", ...runner.snapshot() },
      { type: "tune:state", ...tuner.snapshot() },
    ]);
  });

  add("GET", "/api/queue", false, (_req, res) => sendJson(res, 200, { jobs: queue.list() }));

  add("GET", "/api/jobs/:id/preview.svg", false, (_req, res, params) => {
    streamFileOr404(res, queue.previewPath(params.id), "image/svg+xml");
  });

  add("POST", "/api/estimate", false, async (req, res) => {
    sendJson(res, 200, await submissions.estimate(await readJsonBody(req)));
  });

  add("POST", "/api/submit", false, async (req, res) => {
    const body = await readJsonBody(req);
    const result = await submissions.submit(body);
    bus.log(`New drawing queued: "${result.job.name}".`);
    sendJson(res, 200, result);
  });

  add("GET", "/api/gallery", false, async (_req, res) => sendJson(res, 200, { entries: await gallery.list() }));

  add("GET", "/api/gallery/:id/preview.svg", false, (_req, res, params) => {
    streamFileOr404(res, gallery.previewPath(params.id), "image/svg+xml");
  });

  add("POST", "/api/gallery/:id/enqueue", false, async (req, res, params) => {
    await gallery.list(); // make sure the cache is fresh
    const entry = gallery.get(params.id);
    if (!entry) return sendError(res, 404, "No such gallery entry.");
    if (entry.error) return sendError(res, 422, `This entry failed processing: ${entry.error}`);
    const source = gallery.readSource(entry.id);
    if (!source) return sendError(res, 404, "No such gallery entry.");
    // Treat a gallery pick exactly like a fresh upload: re-prepare from the
    // ORIGINAL source at enqueue time so the queued G-code + ETA use the board's
    // current tuned feed and the latest optimizer — not a cached result. SVGs
    // are re-optimized; authored G-code is streamed as-is (same rule as uploads).
    const result = await submissions.submit(
      source.kind === "svg"
        ? { name: source.name, svgText: source.source }
        : { name: source.name, gcodeText: source.source, optimize: false },
      "gallery"
    );
    bus.log(`Gallery pick queued: "${entry.name}".`);
    sendJson(res, 200, result);
  });

  // ── admin: plot control ──
  add("POST", "/api/admin/login", true, (_req, res) => sendJson(res, 200, { ok: true }));
  add("POST", "/api/admin/start", true, async (req, res) => {
    const body = await readJsonBody(req);
    const job = await runner.start(typeof body.jobId === "string" ? body.jobId : undefined);
    sendJson(res, 200, { job });
  });
  add("POST", "/api/admin/pause", true, (_req, res) => {
    runner.pause();
    sendJson(res, 200, { ok: true });
  });
  add("POST", "/api/admin/resume", true, (_req, res) => {
    runner.resume();
    sendJson(res, 200, { ok: true });
  });
  add("POST", "/api/admin/abort", true, (_req, res) => {
    runner.abort();
    sendJson(res, 200, { ok: true });
  });
  add("POST", "/api/admin/queue/reorder", true, async (req, res) => {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.order)) return sendError(res, 400, "Body must include order: string[].");
    queue.reorder(body.order.map(String));
    sendJson(res, 200, { jobs: queue.list() });
  });
  add("DELETE", "/api/admin/queue/:id", true, (_req, res, params) => {
    queue.remove(params.id);
    sendJson(res, 200, { jobs: queue.list() });
  });
  // Re-place a queued job on the paper — scale, orientation, and/or position —
  // regenerating its G-code + preview + ETA. Only the fields present in the body
  // change; a field set to null resets to auto; omitted fields are unchanged.
  add("POST", "/api/admin/queue/:id/layout", true, async (req, res, params) => {
    const body = await readJsonBody(req);
    const patch: Record<string, unknown> = {};
    if ("fillFraction" in body) {
      const raw = body.fillFraction;
      if (raw != null && (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 1)) {
        return sendError(res, 400, "fillFraction must be a number in (0, 1], or null.");
      }
      patch.fillFraction = raw == null ? null : Number(raw);
    }
    if ("orientation" in body) {
      const raw = body.orientation;
      if (raw != null && raw !== "portrait" && raw !== "landscape") {
        return sendError(res, 400, "orientation must be 'portrait', 'landscape', or null.");
      }
      patch.orientation = raw ?? null;
    }
    for (const key of ["positionXMm", "positionYMm"]) {
      if (key in body) {
        const raw = body[key];
        if (raw != null && (typeof raw !== "number" || !Number.isFinite(raw))) {
          return sendError(res, 400, `${key} must be a number or null.`);
        }
        patch[key] = raw == null ? null : Number(raw);
      }
    }
    const job = await submissions.setLayout(params.id, patch);
    sendJson(res, 200, { job, jobs: queue.list() });
  });

  // ── admin: machine controls ──
  add("POST", "/api/admin/connect", true, async (_req, res) => sendJson(res, 200, await machine.connect()));
  add("POST", "/api/admin/jog", true, async (req, res) => {
    const body = await readJsonBody(req);
    await machine.jog(Number(body.dx ?? 0), Number(body.dy ?? 0), body.feed ? Number(body.feed) : undefined);
    sendJson(res, 200, await machine.status());
  });
  add("POST", "/api/admin/home", true, async (_req, res) => {
    await machine.setHome();
    sendJson(res, 200, await machine.status());
  });
  add("POST", "/api/admin/steppers", true, async (req, res) => {
    const body = await readJsonBody(req);
    await machine.setSteppers(Boolean(body.enabled));
    sendJson(res, 200, { ok: true });
  });
  add("POST", "/api/admin/pen", true, async (req, res) => {
    const body = await readJsonBody(req);
    await machine.penUpDown(Boolean(body.down));
    sendJson(res, 200, { ok: true });
  });
  add("GET", "/api/admin/settings", true, async (_req, res) => sendJson(res, 200, { settings: await machine.getSettings() }));
  add("POST", "/api/admin/settings", true, async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, { settings: await machine.setSetting(String(body.key), Number(body.value)) });
  });
  add("POST", "/api/admin/reset-defaults", true, async (_req, res) => {
    sendJson(res, 200, { settings: await machine.resetDefaults() });
  });
  // Manually pull queued jobs + gallery up to the board's current tuned feed.
  add("POST", "/api/admin/refeed", true, async (_req, res) => {
    sendJson(res, 200, { result: await refeed.refresh() });
  });
  add("POST", "/api/admin/shape", true, async (req, res) => {
    const body = await readJsonBody(req);
    const shape = String(body.shape);
    if (!["circle", "slow-circle", "max-circle", "backlash"].includes(shape)) {
      return sendError(res, 400, "shape must be circle | slow-circle | max-circle | backlash.");
    }
    // Long-running: acknowledge immediately, progress arrives over SSE.
    machine.drawShape(shape as Parameters<MachineService["drawShape"]>[0]).catch((error) => {
      bus.log(`! Shape error: ${(error as Error).message}`);
    });
    sendJson(res, 200, { ok: true });
  });

  // ── admin: tuner + ETA calibration ──
  add("POST", "/api/admin/tune/start", true, async (req, res) => {
    const body = await readJsonBody(req);
    await tuner.startSession(String(body.mode ?? "coarse"), String(body.tests ?? "CDAB"));
    sendJson(res, 200, { ok: true });
  });
  add("POST", "/api/admin/tune/verdict", true, async (req, res) => {
    const body = await readJsonBody(req);
    tuner.submitVerdict(String(body.v));
    sendJson(res, 200, { ok: true });
  });
  add("POST", "/api/admin/tune/stop", true, (_req, res) => {
    tuner.stopSession();
    sendJson(res, 200, { ok: true });
  });
  add("POST", "/api/admin/calibrate", true, async (req, res) => {
    const body = await readJsonBody(req);
    await tuner.runCalibration(body.repeats ? Number(body.repeats) : undefined);
    sendJson(res, 200, { ok: true });
  });
  add("POST", "/api/admin/calibrate/save", true, (_req, res) => {
    sendJson(res, 200, { calibration: tuner.saveCalibration() });
  });

  return routes;
}

/**
 * Re-place queued jobs whose baked-in mounting no longer matches the current
 * `PAPER_MIRROR_X` config, so a config change (e.g. correcting the X-axis
 * direction) takes effect on jobs already in the queue — not just new ones.
 * Preserves each job's scale/orientation/position (re-applies its stored
 * layoutRequest); only jobs with a retained source can be re-placed.
 */
async function relayoutStaleQueuedJobs(services: Services): Promise<void> {
  const { config, queue, submissions, bus } = services;
  let updated = 0;
  for (const job of queue.list()) {
    if (job.status !== "queued" || !job.layout || !job.sourceKind) continue;
    if (job.layout.mirrorX === config.paperMirrorX) continue; // already current
    try {
      await submissions.setLayout(job.id, {}); // empty patch → re-apply stored request
      updated++;
    } catch (error) {
      bus.log(`Re-layout skipped job ${job.id}: ${(error as Error).message}`);
    }
  }
  if (updated) bus.log(`Re-placed ${updated} queued job(s) for the current paper mounting.`);
}

function streamFileOr404(response: ServerResponse, filePath: string, contentType: string): void {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType });
    response.end(data);
  });
}

export function createServer(services: Services): http.Server {
  const routes = buildRoutes(services);
  const { config } = services;

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathName = url.pathname;

    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = pathName.match(route.pattern);
      if (!match) continue;

      if (route.admin && !checkAdminPassword(request, config.adminPassword)) {
        return sendError(response, 401, config.adminPassword ? "Wrong admin password." : "Admin API disabled: set ADMIN_PASSWORD on the server.");
      }
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => (params[name] = match[index + 1]));
      try {
        await route.handler(request, response, params);
      } catch (error) {
        if (!response.headersSent) sendError(response, 500, (error as Error).message);
      }
      return;
    }

    if (pathName.startsWith("/api/")) return sendError(response, 404, "No such endpoint.");
    if (fs.existsSync(config.staticDir)) return serveStatic(response, config.staticDir, pathName);
    sendJson(response, 200, {
      message: "plotter-backend is running (API only). Build the frontend to serve it from here.",
    });
  });
}

function main(): void {
  const services = buildServices();
  const { config, bus, serial, gallery } = services;
  const server = createServer(services);
  bus.startHeartbeat();

  server.listen(config.httpPort, config.host, () => {
    console.log(`plotter-backend listening on http://${config.host}:${config.httpPort}`);
    console.log(`  data:    ${config.dataDir}`);
    console.log(`  gallery: ${config.galleryDir}`);
    console.log(`  serial:  ${config.simulate ? "SIMULATED plotter" : config.serialPort || "auto-detect on first use"}`);

    // Recompute every drawing's SVG→G-code from scratch on startup so the
    // gallery reflects the current optimizer/generator code. Run in the
    // background (don't block accepting requests). In simulate mode bring the
    // board up first so the tuned $110 feed is used instead of the fallback.
    const boardReady = config.simulate ? serial.ensure().catch(() => undefined) : Promise.resolve();
    void boardReady
      .then(() => gallery.refreshAll())
      .then((entries) => {
        const failed = entries.filter((entry) => entry.error).length;
        const message = `Recomputed ${entries.length} gallery drawing(s) at startup${failed ? ` — ${failed} failed` : ""}.`;
        console.log(`  ${message}`);
        bus.log(message);
      })
      .then(() => relayoutStaleQueuedJobs(services))
      .catch((error) => {
        const message = `Gallery recompute failed: ${(error as Error).message}`;
        console.error(`  ! ${message}`);
        bus.log(`! ${message}`);
      });
  });

  const shutdown = async () => {
    services.pipeline.destroy();
    await serial.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) main();

export { buildServices };
