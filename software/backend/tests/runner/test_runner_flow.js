"use strict";
// PlotRunner against the simulated firmware: full run, pause/resume, abort,
// machine-lock exclusion, and error handling on rejected lines.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventBus } = require("../../dist/events");
const { SerialManager } = require("../../dist/serial-manager");
const { MachineLock } = require("../../dist/machine-lock");
const { QueueService } = require("../../dist/queue");
const { PlotRunner } = require("../../dist/runner");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
  const bus = new EventBus();
  const events = [];
  const originalBroadcast = bus.broadcast.bind(bus);
  bus.broadcast = (event) => {
    events.push(event);
    originalBroadcast(event);
  };
  const serial = new SerialManager({ simulate: true, preferredPort: "", bus });
  const lock = new MachineLock();
  const queue = new QueueService(dir, () => {});
  const runner = new PlotRunner(serial, bus, queue, lock);
  return { bus, events, serial, lock, queue, runner };
}

function queueProgram(queue, name, lines) {
  return queue.add({
    name,
    source: "gcode-upload",
    gcode: lines.join("\n") + "\n",
    previewSvg: "<svg xmlns='http://www.w3.org/2000/svg'/>",
    etaSeconds: 1,
    stats: null,
  });
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error("condition not reached in time");
}

module.exports = {
  name: "plot runner",
  run(t) {
    t.check("streams a job to completion with progress events", async (assert) => {
      const { events, queue, runner } = makeWorld();
      const job = queueProgram(queue, "small", [
        "G21 G90", "M3", "G1 X10 Y0 F1500", "G1 X10 Y10", "M5", "G0 X0 Y0",
      ]);
      await runner.start();
      await waitFor(() => queue.get(job.id).status === "done");
      assert.ok(events.some((event) => event.type === "progress"), "progress events published");
      const finished = events.find((event) => event.type === "plotFinished");
      assert.strictEqual(finished.status, "done");
      assert.strictEqual(runner.snapshot().state, "idle");
    });

    t.check("abort soft-resets and marks the job aborted", async (assert) => {
      const { queue, runner } = makeWorld();
      // Long move (240 s at F1500 unscaled → ~5 s at the test time scale) so
      // the abort lands mid-plot.
      const job = queueProgram(queue, "long", [
        "G21 G90", "M3", "G1 X6000 Y0 F1500", "G1 X6000 Y6000", "M5",
      ]);
      await runner.start();
      await delay(150);
      runner.abort();
      await waitFor(() => queue.get(job.id).status === "aborted");
      assert.strictEqual(runner.snapshot().state, "idle");
    });

    t.check("pause holds, resume releases, plot still finishes", async (assert) => {
      const { queue, runner, serial } = makeWorld();
      const job = queueProgram(queue, "pausable", [
        "G21 G90", "M3", "G1 X400 Y0 F1500", "M5",
      ]);
      await runner.start();
      await delay(80);
      runner.pause();
      assert.strictEqual(queue.get(job.id).status, "paused");
      const connection = await serial.ensure();
      const held = await connection.status();
      assert.strictEqual(held.state, "Hold");
      runner.resume();
      await waitFor(() => queue.get(job.id).status === "done");
    });

    t.check("machine lock blocks a second concurrent plot", async (assert) => {
      const { queue, runner } = makeWorld();
      queueProgram(queue, "one", ["G21 G90", "G1 X2000 Y0 F1500"]);
      const second = queueProgram(queue, "two", ["G21 G90", "G1 X1 Y0 F1500"]);
      await runner.start();
      await assert.rejects(() => runner.start(second.id), /busy/i);
      runner.abort();
      await waitFor(() => runner.snapshot().state === "idle");
    });

    t.check("a rejected line fails the job with the firmware error", async (assert) => {
      const { queue, runner } = makeWorld();
      const job = queueProgram(queue, "bad", ["G21 G90", "$bogus=1", "G1 X1 Y0"]);
      await runner.start();
      await waitFor(() => queue.get(job.id).status === "failed");
      assert.match(queue.get(job.id).error, /error:3/);
    });
  },
};
