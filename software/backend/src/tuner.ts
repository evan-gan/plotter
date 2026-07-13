// TunerService: drives firmware/tools' tune-engine (speed/accel bisection)
// and calibrate (ETA knobs) over the event bus, so the Svelte admin panel is
// the control surface. Events are namespaced:
//   tune:running / tune:log→log / tune:prompt / tune:clearPrompt /
//   tune:settings / tune:summary — and cal:start / cal:row / cal:summary /
//   cal:saved for ETA calibration.

import { tuneEngine, calibrateLib, calibrationStore } from "./firmware-bridge";
import { SerialManager } from "./serial-manager";
import { EventBus } from "./events";
import { MachineLock } from "./machine-lock";
import { PlotRefeedService } from "./refeed";

export class TunerService {
  private serial: SerialManager;
  private bus: EventBus;
  private lock: MachineLock;
  private refeed: PlotRefeedService;
  private running = false;
  private aborting = false;
  private resolveVerdict: ((verdict: string) => void) | null = null;
  private lastCalibration: Record<string, number> | null = null;
  private activePrompt: Record<string, unknown> | null = null;

  constructor(serial: SerialManager, bus: EventBus, lock: MachineLock, refeed: PlotRefeedService) {
    this.serial = serial;
    this.bus = bus;
    this.lock = lock;
    this.refeed = refeed;
  }

  /** Refeed queued jobs to the (possibly new) tuned feed, logging any failure. */
  private triggerRefeed(): void {
    this.refeed
      .refresh()
      .catch((error) => this.bus.log(`! Refeed after tuning failed: ${(error as Error).message}`));
  }

  snapshot() {
    return {
      running: this.running,
      prompt: this.activePrompt,
      lastCalibration: this.lastCalibration,
      savedCalibration: calibrationStore.loadCalibration(),
    };
  }

  /** Start a tuning session (mode: coarse|fine, tests: subset of "CDAB"). */
  async startSession(mode: string, tests: string): Promise<void> {
    if (this.running) throw new Error("A tuning session is already running.");
    if (!/^[CDAB]{1,4}$/.test(tests)) throw new Error("tests must be a subset of CDAB.");
    const connection = await this.serial.ensure();
    this.lock.acquire("tuning session");
    this.running = true;
    this.aborting = false;
    this.bus.broadcast({ type: "tune:running", running: true });

    const io = {
      log: (text: string) => this.bus.log(text),
      settings: (values: Record<string, number>) => this.bus.broadcast({ type: "tune:settings", values }),
      summary: (rows: unknown[]) => this.bus.broadcast({ type: "tune:summary", rows }),
      verdict: (context: Record<string, unknown>) =>
        new Promise<string>((resolve) => {
          if (this.aborting) return resolve("q");
          this.resolveVerdict = resolve;
          this.activePrompt = context;
          this.bus.broadcast({ type: "tune:prompt", ...context });
        }),
    };

    tuneEngine
      .runSession(connection, { mode: mode === "fine" ? "fine" : "coarse", tests, io })
      .then(() => this.bus.log("Tuning done. Values persist on the board across power cycles."))
      .catch((error) => this.bus.log(`! Tuning session error: ${(error as Error).message}`))
      .finally(() => {
        this.running = false;
        this.resolveVerdict = null;
        this.activePrompt = null;
        this.lock.release("tuning session");
        this.bus.broadcast({ type: "tune:running", running: false });
        // $110 may have changed — pull queued jobs up to the new tuned feed.
        this.triggerRefeed();
      });
  }

  /** Operator's answer to the current prompt: y (pass), n (fail), r, q. */
  submitVerdict(verdict: string): void {
    if (!["y", "n", "r", "q"].includes(verdict)) throw new Error("Verdict must be y, n, r, or q.");
    if (!this.resolveVerdict) throw new Error("No tuning prompt is waiting for an answer.");
    const resolve = this.resolveVerdict;
    this.resolveVerdict = null;
    this.activePrompt = null;
    this.bus.broadcast({ type: "tune:clearPrompt" });
    resolve(verdict);
  }

  stopSession(): void {
    this.aborting = true;
    if (this.resolveVerdict) this.submitVerdict("q");
  }

  /** Run the ETA calibration harness (pen up, ~80 mm of +X/+Y needed). */
  async runCalibration(repeats?: number): Promise<void> {
    if (this.running) throw new Error("The tuner is busy.");
    const connection = await this.serial.ensure();
    this.lock.acquire("ETA calibration");
    this.running = true;
    this.lastCalibration = null;
    this.bus.broadcast({ type: "cal:start" });
    this.bus.log("ETA calibration — pen stays up; clear ~80 mm of +X/+Y travel.");

    const io = {
      log: (text: string) => this.bus.log(text),
      result: (row: unknown) => this.bus.broadcast({ type: "cal:row", row }),
      summary: (rows: unknown[], calibration: Record<string, number>) => {
        this.lastCalibration = calibration;
        this.bus.broadcast({ type: "cal:summary", rows, calibration });
      },
    };

    calibrateLib
      .runCalibration(connection, { io, repeats })
      .catch((error) => this.bus.log(`! Calibration error: ${(error as Error).message}`))
      .finally(() => {
        this.running = false;
        this.lock.release("ETA calibration");
        this.bus.broadcast({ type: "cal:done" });
      });
  }

  /** Persist the knobs from the latest run to eta-calibration.json (host). */
  saveCalibration(): Record<string, unknown> {
    if (!this.lastCalibration) throw new Error("No calibration to save — run it first.");
    const stamped = { ...this.lastCalibration, savedAt: new Date().toISOString(), note: "admin panel" };
    const written = calibrationStore.saveCalibration(stamped);
    this.bus.log(`Saved ETA calibration to ${written}.`);
    this.bus.broadcast({ type: "cal:saved", calibration: stamped });
    // Calibration follows tuning; refresh queued jobs to the tuned feed + ETA.
    this.triggerRefeed();
    return stamped;
  }
}
