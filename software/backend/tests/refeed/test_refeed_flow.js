"use strict";
// PlotRefeedService against the simulator: after the board's tuned feed ($110)
// rises, queued jobs we generated are rewritten to the new feed (and their ETA
// drops), while authored G-code is left untouched.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventBus } = require("../../dist/events");
const { SerialManager } = require("../../dist/serial-manager");
const { EtaService } = require("../../dist/eta");
const { QueueService } = require("../../dist/queue");
const { GalleryService } = require("../../dist/gallery");
const { SubmissionService } = require("../../dist/submissions");
const { PlotRefeedService } = require("../../dist/refeed");

const TEST_SVG = `<svg xmlns="http://www.w3.org/2000/svg">
  <line x1="0" y1="0" x2="30" y2="0"/>
  <line x1="30" y1="0" x2="30" y2="30"/>
</svg>`;

// A long stroke that actually cruises at the tuned feed: with the sim's accel
// ($120 = 200 mm/s²) a 300 mm move reaches 100 mm/s ($110 = 6000) but only
// 25 mm/s at the default $110 = 1500, so its ETA visibly drops after a refeed.
// (Short moves are accel-limited and wouldn't change — see the code comment.)
const LONG_SVG = `<svg xmlns="http://www.w3.org/2000/svg">
  <line x1="0" y1="0" x2="300" y2="0"/>
</svg>`;

function makeWorld() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refeed-data-"));
  const galleryDir = fs.mkdtempSync(path.join(os.tmpdir(), "refeed-gallery-"));
  // Paper large enough that the 300 mm test line still cruises (isn't shrunk):
  // landscape drawable ≈ 374.6 mm, so the line keeps its length at 1:1.
  const config = {
    dataDir, galleryDir, workWidthMm: 400, workHeightMm: 400, drawFeedMmMin: 1500,
    paperShortMm: 400 * (8.5 / 11), paperLongMm: 400, paperPaddingMm: 12.7, paperMirrorX: true,
  };
  const bus = new EventBus();
  const serial = new SerialManager({ simulate: true, preferredPort: "", bus });
  const eta = new EtaService(serial);
  const queue = new QueueService(dataDir, () => {});
  const gallery = new GalleryService(config, eta);
  const submissions = new SubmissionService(config, eta, queue);
  const refeed = new PlotRefeedService(eta, queue, gallery, bus);
  return { serial, eta, queue, submissions, refeed };
}

const feedOf = (queue, jobId) =>
  fs.readFileSync(queue.gcodePath(jobId), "utf8").match(/^G1 F(\d+)/m)?.[1];

module.exports = {
  name: "plot refeed",
  run(t) {
    t.check("bumps a generated job to the newly-tuned feed and lowers its ETA", async (assert) => {
      const { serial, queue, submissions, refeed } = makeWorld();
      const connection = await serial.ensure();

      // Submitted while the board is at the default $110 = 1500.
      const { job } = await submissions.submit({ name: "line", svgText: LONG_SVG });
      assert.strictEqual(feedOf(queue, job.id), "1500", "generated at the default feed");
      const slowEta = queue.get(job.id).etaSeconds;

      // Operator retunes: raise both the user feed cap ($110) and the motor-rate
      // cap ($112) — the ETA caps each move by min($110, $112/load), so both must
      // rise for a pure-axis move to actually speed up. Then refeed.
      await connection.sendLine("$110=6000");
      await connection.sendLine("$112=6000");
      const result = await refeed.refresh();
      assert.strictEqual(result.updated, 1, "one job rewritten");
      assert.strictEqual(Math.round(result.feedMmMin), 6000, "used the tuned feed");
      assert.strictEqual(feedOf(queue, job.id), "6000", "gcode now draws at the tuned feed");

      const fastEta = queue.get(job.id).etaSeconds;
      assert.ok(fastEta < slowEta, `ETA should drop after refeed (${fastEta} < ${slowEta})`);
    });

    t.check("leaves authored G-code untouched", async (assert) => {
      const { serial, queue, submissions, refeed } = makeWorld();
      const connection = await serial.ensure();

      // Raw authored program (no generator marker) streamed as-is.
      const authored = "G21 G90\nM3\nG1 X10 Y0 F1500\nG1 X10 Y10\nM5\nG0 X0 Y0\n";
      const { job } = await submissions.submit(
        { name: "authored", gcodeText: authored, optimize: false }
      );

      await connection.sendLine("$110=6000");
      const result = await refeed.refresh();
      assert.strictEqual(result.updated, 0, "authored gcode is never rewritten");
      assert.strictEqual(
        fs.readFileSync(queue.gcodePath(job.id), "utf8"), authored, "byte-for-byte unchanged"
      );
    });

    t.check("second refeed is a no-op once jobs are already at the tuned feed", async (assert) => {
      const { serial, queue, submissions, refeed } = makeWorld();
      const connection = await serial.ensure();
      await submissions.submit({ name: "line", svgText: TEST_SVG });
      await connection.sendLine("$110=6000");

      assert.strictEqual((await refeed.refresh()).updated, 1, "first refeed rewrites");
      assert.strictEqual((await refeed.refresh()).updated, 0, "second refeed changes nothing");
    });
  },
};
