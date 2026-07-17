"use strict";
// Paper placement + per-job rescale through the SubmissionService, against the
// simulator: an SVG upload is placed on the paper (layout metadata attached),
// and the admin can rescale a queued job (regenerating its G-code + ETA).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventBus } = require("../../dist/events");
const { SerialManager } = require("../../dist/serial-manager");
const { EtaService } = require("../../dist/eta");
const { QueueService } = require("../../dist/queue");
const { SubmissionService } = require("../../dist/submissions");

// A wide, short drawing so the auto-orientation should pick landscape.
const WIDE_SVG = `<svg xmlns="http://www.w3.org/2000/svg">
  <line x1="0" y1="0" x2="200" y2="0"/>
  <line x1="0" y1="0" x2="0" y2="40"/>
  <line x1="200" y1="0" x2="200" y2="40"/>
</svg>`;

function makeWorld() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-data-"));
  const config = {
    dataDir, galleryDir: dataDir, workWidthMm: 120, workHeightMm: 120, drawFeedMmMin: 1500,
    paperShortMm: 120 * (8.5 / 11), paperLongMm: 120, paperPaddingMm: 12.7, paperMirrorX: true,
  };
  const bus = new EventBus();
  const serial = new SerialManager({ simulate: true, preferredPort: "", bus });
  const eta = new EtaService(serial);
  const queue = new QueueService(dataDir, () => {});
  const submissions = new SubmissionService(config, eta, queue);
  return { serial, queue, submissions };
}

module.exports = {
  name: "paper layout submission flow",
  run(t) {
    t.check("SVG upload is placed on paper with layout metadata + retained source", async (assert) => {
      const { serial, queue, submissions } = makeWorld();
      await serial.ensure();
      const { job } = await submissions.submit({ name: "wide", svgText: WIDE_SVG });

      assert.ok(job.layout, "layout metadata attached");
      assert.strictEqual(job.layout.orientation, "landscape", "wide drawing → landscape");
      assert.strictEqual(job.sourceKind, "svg");
      assert.ok(job.layout.contentWidthMm <= job.layout.paperWidthMm, "content fits the sheet width");
      // Shrink-to-fit default fills the sheet here (200 mm wide must shrink).
      assert.ok(Math.abs(job.layout.fillFraction - 1) < 1e-6, "fills the sheet when it must shrink");
      assert.ok(queue.readSource(job.id), "original SVG retained for rescale");
    });

    t.check("setLayout scale shrinks the plot and lowers its ETA", async (assert) => {
      const { serial, queue, submissions } = makeWorld();
      await serial.ensure();
      const { job } = await submissions.submit({ name: "wide", svgText: WIDE_SVG });
      const fullEta = queue.get(job.id).etaSeconds;
      const fullContentWidth = job.layout.contentWidthMm;

      const rescaled = await submissions.setLayout(job.id, { fillFraction: 0.5 });
      assert.ok(Math.abs(rescaled.layout.fillFraction - 0.5) < 1e-6, "fill fraction now 0.5");
      assert.ok(
        rescaled.layout.contentWidthMm < fullContentWidth - 1e-6,
        `content shrank (${rescaled.layout.contentWidthMm} < ${fullContentWidth})`
      );
      assert.ok(rescaled.etaSeconds < fullEta, `ETA dropped (${rescaled.etaSeconds} < ${fullEta})`);

      // Default-placed G-code stays inside the padded sheet (all coords ≥ 0).
      const gcode = fs.readFileSync(queue.gcodePath(job.id), "utf8");
      assert.ok(!/[XY]-/.test(gcode), "no negative coordinates — content stays in the work area");
    });

    t.check("setLayout merges a position change onto the existing scale", async (assert) => {
      const { serial, queue, submissions } = makeWorld();
      await serial.ensure();
      const { job } = await submissions.submit({ name: "wide", svgText: WIDE_SVG });
      await submissions.setLayout(job.id, { fillFraction: 0.5 });
      // Change only the position — scale must stay at 0.5.
      const moved = await submissions.setLayout(job.id, { positionXMm: 20, positionYMm: 20 });
      assert.ok(Math.abs(moved.layout.fillFraction - 0.5) < 1e-6, "scale preserved across a move");
      assert.ok(Math.abs(moved.layout.positionXMm - 20) < 1e-6, "position applied");
      assert.strictEqual(moved.layoutRequest.positionXMm, 20, "position persisted in the request");
    });

    t.check("setLayout orientation override flips the paper", async (assert) => {
      const { serial, queue, submissions } = makeWorld();
      await serial.ensure();
      const { job } = await submissions.submit({ name: "wide", svgText: WIDE_SVG });
      assert.strictEqual(job.layout.orientation, "landscape", "auto picked landscape");
      const portrait = await submissions.setLayout(job.id, { orientation: "portrait" });
      assert.strictEqual(portrait.layout.orientation, "portrait", "forced portrait");
      assert.ok(portrait.layout.paperHeightMm > portrait.layout.paperWidthMm, "portrait is taller than wide");
    });

    t.check("setLayout rejects a non-queued job", async (assert) => {
      const { serial, queue, submissions } = makeWorld();
      await serial.ensure();
      const { job } = await submissions.submit({ name: "wide", svgText: WIDE_SVG });
      queue.update(job.id, { status: "done" });
      let threw = false;
      try {
        await submissions.setLayout(job.id, { fillFraction: 0.5 });
      } catch {
        threw = true;
      }
      assert.ok(threw, "re-placing a non-queued job throws");
    });
  },
};
