// PlotRunner: streams one queued job's G-code to the board with ok/error
// flow control (same protocol as firmware/tools/stream.js), publishing
// progress over the event bus, with realtime pause (!), resume (~) and
// abort (0x18 soft reset).

import fs from "fs";
import { BaseConnection, delay } from "./connection";
import { SerialManager } from "./serial-manager";
import { EventBus } from "./events";
import { QueueService, Job } from "./queue";
import { MachineLock } from "./machine-lock";

const PER_LINE_TIMEOUT_MS = 120_000;
const PROGRESS_EVERY_LINES = 5;

export type RunnerState = "idle" | "plotting" | "paused" | "aborting";

export class PlotRunner {
  private serial: SerialManager;
  private bus: EventBus;
  private queue: QueueService;
  private lock: MachineLock;
  private state: RunnerState = "idle";
  private currentJobId: string | null = null;
  private abortRequested = false;
  /** Resolves the moment abort() is called, to cut short a blocked sendLine
   *  (the firmware holds `ok` back while its planner buffer is full). */
  private abortSignal: Promise<"aborted"> = new Promise(() => {});
  private raiseAbort: () => void = () => {};
  private startedAtMs = 0;
  private linesSent = 0;
  private lineTotal = 0;

  constructor(serial: SerialManager, bus: EventBus, queue: QueueService, lock: MachineLock) {
    this.serial = serial;
    this.bus = bus;
    this.queue = queue;
    this.lock = lock;
  }

  snapshot() {
    return {
      state: this.state,
      jobId: this.currentJobId,
      linesSent: this.linesSent,
      lineTotal: this.lineTotal,
      elapsedSeconds: this.state === "idle" ? 0 : (Date.now() - this.startedAtMs) / 1000,
    };
  }

  /** Start the given queued job (or the next one). Resolves when the plot
   *  finishes/aborts; callers usually fire-and-forget and watch the bus. */
  async start(jobId?: string): Promise<Job> {
    const job = jobId ? this.queue.get(jobId) : this.queue.pending()[0];
    if (!job) throw new Error(jobId ? `No job ${jobId}.` : "The queue is empty.");
    if (job.status !== "queued") throw new Error(`Job "${job.name}" is ${job.status}, not queued.`);

    this.lock.acquire(`plotting "${job.name}"`);
    const connection = await this.serial.ensure().catch((error) => {
      this.lock.release(`plotting "${job.name}"`);
      throw error;
    });

    this.state = "plotting";
    this.currentJobId = job.id;
    this.abortRequested = false;
    this.abortSignal = new Promise((resolve) => {
      this.raiseAbort = () => resolve("aborted");
    });
    this.startedAtMs = Date.now();
    this.queue.update(job.id, { status: "plotting", startedAt: new Date().toISOString() });
    this.bus.log(`Plot started: "${job.name}" (${job.lineCount} lines).`);

    this.run(connection, job).catch((error) => {
      this.finish(job, "failed", (error as Error).message);
    });
    return job;
  }

  private async run(connection: BaseConnection, job: Job): Promise<void> {
    const lines = fs
      .readFileSync(this.queue.gcodePath(job.id), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith(";"));
    this.lineTotal = lines.length;
    this.linesSent = 0;

    for (const line of lines) {
      if (this.abortRequested) return this.finishAbort(connection, job);
      const reply = await Promise.race([connection.sendLine(line, PER_LINE_TIMEOUT_MS), this.abortSignal]);
      if (reply === "aborted" || this.abortRequested) return this.finishAbort(connection, job);
      if (reply === "timeout") {
        return this.finish(job, "failed", `Firmware stopped answering on: ${line}`);
      }
      if (reply.startsWith("error")) {
        return this.finish(job, "failed", `Firmware rejected "${line}" with ${reply}.`);
      }
      this.linesSent++;
      if (this.linesSent % PROGRESS_EVERY_LINES === 0 || this.linesSent === this.lineTotal) {
        this.publishProgress(job);
      }
    }

    // All lines accepted; wait for the buffered motion to actually finish.
    // Polled locally (not waitIdle) so an abort can cut in immediately.
    const idleDeadline = Date.now() + 10 * 60_000;
    while (Date.now() < idleDeadline) {
      if (this.abortRequested) return this.finishAbort(connection, job);
      const { state } = await connection.status();
      if (state === "Idle") break;
      await delay(200);
    }
    if (this.abortRequested) return this.finishAbort(connection, job);
    this.finish(job, "done", null);
  }

  private publishProgress(job: Job): void {
    this.bus.broadcast({
      type: "progress",
      jobId: job.id,
      linesSent: this.linesSent,
      lineTotal: this.lineTotal,
      elapsedSeconds: (Date.now() - this.startedAtMs) / 1000,
      etaSeconds: job.etaSeconds,
      state: this.state,
    });
  }

  /** Realtime feed hold — takes effect within one motion segment. */
  pause(): void {
    if (this.state !== "plotting") throw new Error("Nothing is plotting.");
    this.serialRaw("!");
    this.state = "paused";
    if (this.currentJobId) this.queue.update(this.currentJobId, { status: "paused" });
    this.bus.log("Paused (feed hold).");
  }

  resume(): void {
    if (this.state !== "paused") throw new Error("Nothing is paused.");
    this.serialRaw("~");
    this.state = "plotting";
    if (this.currentJobId) this.queue.update(this.currentJobId, { status: "plotting" });
    this.bus.log("Resumed.");
  }

  /** Abort: stop motion NOW (soft reset), then let the loop clean up. */
  abort(): void {
    if (this.state === "idle") throw new Error("Nothing is plotting.");
    this.abortRequested = true;
    if (this.state === "paused") this.serialRaw("~"); // release the hold so reset lands cleanly
    this.serialRaw("\x18");
    this.state = "aborting";
    this.raiseAbort();
    this.bus.log("Abort requested…");
  }

  private async finishAbort(connection: BaseConnection, job: Job): Promise<void> {
    connection.sendRaw("\x18"); // soft reset: clears planner + raises the pen logic-side
    await delay(400);
    await connection.sendLine("M5", 3000); // make sure the pen is physically up
    await connection.sendLine("M18", 3000); // release steppers — position is now untrusted
    this.finish(job, "aborted", null);
    this.bus.log('Aborted. Steppers released — re-home ("set home") before the next plot.');
  }

  private finish(job: Job, status: "done" | "failed" | "aborted", error: string | null): void {
    this.queue.update(job.id, { status, error, finishedAt: new Date().toISOString() });
    this.state = "idle";
    this.currentJobId = null;
    this.lock.release(`plotting "${job.name}"`);
    this.bus.broadcast({ type: "plotFinished", jobId: job.id, status, error });
    this.bus.log(
      status === "done" ? `Plot finished: "${job.name}".` : `Plot ${status}: "${job.name}"${error ? ` — ${error}` : ""}.`
    );
  }

  private serialRaw(bytes: string): void {
    if (!this.serial.isConnected) throw new Error("Serial connection lost.");
    void this.serial.ensure().then((connection) => connection.sendRaw(bytes));
  }
}
