"use strict";
// End-to-end API test: real HTTP server + simulator, exercising the public
// submit/estimate/queue/gallery flow and admin auth.

const fs = require("fs");
const path = require("path");
const os = require("os");

const PASSWORD = "test-password-123";

function post(base, urlPath, body, headers = {}) {
  return fetch(base + urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

const TEST_SVG = `<svg xmlns="http://www.w3.org/2000/svg">
  <line x1="0" y1="0" x2="30" y2="0"/>
  <line x1="30" y1="0" x2="30" y2="30"/>
  <rect x="50" y="50" width="20" height="20"/>
</svg>`;

module.exports = {
  name: "http api (simulated board)",
  run(t) {
    let base;
    let server;

    t.check("server boots with simulator + empty gallery", async (assert) => {
      process.env.ADMIN_PASSWORD = PASSWORD;
      process.env.PLOTTER_SIMULATE = "1";
      process.env.GALLERY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-test-"));
      process.env.PORT = "0";
      const { buildServices, createServer } = require("../../dist/server");
      const services = buildServices();
      server = createServer(services);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${server.address().port}`;

      const health = await (await fetch(base + "/api/health")).json();
      assert.deepStrictEqual(health, { ok: true });
      const status = await (await fetch(base + "/api/status")).json();
      assert.strictEqual(status.simulated, true);
      assert.strictEqual(status.adminEnabled, true);
    });

    t.check("estimate returns an ETA + optimizer stats for an SVG", async (assert) => {
      const response = await post(base, "/api/estimate", { svgText: TEST_SVG });
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.ok(body.eta.seconds > 0, "positive ETA");
      assert.ok(body.previewSvg.startsWith("<svg"));
      assert.ok(body.stats, "optimizer ran");
      assert.ok(body.stats.penUpAfterMm <= body.stats.penUpBeforeMm);
    });

    t.check("submit queues a job and preview is served", async (assert) => {
      const response = await post(base, "/api/submit", { name: "My <b>Test</b>", svgText: TEST_SVG });
      assert.strictEqual(response.status, 200);
      const { job } = await response.json();
      assert.strictEqual(job.status, "queued");
      assert.strictEqual(job.name, "My bTestb"); // <>/ stripped by sanitizeName
      const queueBody = await (await fetch(base + "/api/queue")).json();
      assert.strictEqual(queueBody.jobs.length, 1);
      const preview = await fetch(base + `/api/jobs/${job.id}/preview.svg`);
      assert.strictEqual(preview.status, 200);
      assert.match(await preview.text(), /^<svg/);
    });

    t.check("bad submissions get clear 4xx/5xx errors", async (assert) => {
      const empty = await post(base, "/api/submit", { name: "nothing" });
      assert.strictEqual(empty.status, 500);
      assert.match((await empty.json()).error, /svgText or gcodeText/);
      const unparsable = await post(base, "/api/estimate", { svgText: "<svg></svg>" });
      assert.match((await unparsable.json()).error, /no drawable geometry/);
    });

    t.check("admin endpoints reject wrong/missing password", async (assert) => {
      const noPass = await post(base, "/api/admin/start", {});
      assert.strictEqual(noPass.status, 401);
      const wrongPass = await post(base, "/api/admin/start", {}, { "x-admin-password": "nope" });
      assert.strictEqual(wrongPass.status, 401);
      const login = await post(base, "/api/admin/login", {}, { "x-admin-password": PASSWORD });
      assert.strictEqual(login.status, 200);
    });

    t.check("admin start plots the queued job to done", async (assert) => {
      const auth = { "x-admin-password": PASSWORD };
      const started = await post(base, "/api/admin/start", {}, auth);
      assert.strictEqual(started.status, 200);
      const deadline = Date.now() + 8000;
      let status = null;
      while (Date.now() < deadline) {
        const queueBody = await (await fetch(base + "/api/queue")).json();
        status = queueBody.jobs[0].status;
        if (status === "done") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.strictEqual(status, "done");
    });

    t.check("gallery: svg file appears with ETA and can be enqueued", async (assert) => {
      fs.writeFileSync(path.join(process.env.GALLERY_DIR, "star-drawing.svg"), TEST_SVG);
      const galleryBody = await (await fetch(base + "/api/gallery")).json();
      assert.strictEqual(galleryBody.entries.length, 1);
      const entry = galleryBody.entries[0];
      assert.strictEqual(entry.name, "star drawing");
      assert.ok(entry.etaSeconds > 0);
      const enqueue = await post(base, `/api/gallery/${entry.id}/enqueue`, {});
      assert.strictEqual(enqueue.status, 200);
      const { job } = await enqueue.json();
      assert.strictEqual(job.source, "gallery");
    });

    t.check("machine controls work over the API (jog/home/settings)", async (assert) => {
      const auth = { "x-admin-password": PASSWORD };
      const jog = await post(base, "/api/admin/jog", { dx: 5, dy: 5 }, auth);
      assert.strictEqual(jog.status, 200);
      const home = await post(base, "/api/admin/home", {}, auth);
      const homed = await home.json();
      assert.strictEqual(homed.mx, 0);
      const settingsResponse = await fetch(base + "/api/admin/settings", { headers: auth });
      const { settings } = await settingsResponse.json();
      assert.strictEqual(settings.$110, 1500);
      const write = await post(base, "/api/admin/settings", { key: "$110", value: 2000 }, auth);
      assert.strictEqual((await write.json()).settings.$110, 2000);
      const oversizeJog = await post(base, "/api/admin/jog", { dx: 999, dy: 0 }, auth);
      assert.strictEqual(oversizeJog.status, 500);
      server.close();
    });
  },
};
