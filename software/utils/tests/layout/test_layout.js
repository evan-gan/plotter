"use strict";
// Paper placement: orientation choice, shrink-to-fit scaling, X mirroring,
// and bottom-right anchoring.

const { layoutOnPaper, machineToPaperView } = require("../../dist/layout");
const { boundingBox } = require("../../dist/types");

// Paper: 90 × 120 with 10 mm padding → portrait drawable 70×100, landscape 100×70.
const PAPER = { paperShortMm: 90, paperLongMm: 120, paddingMm: 10 };

function drawingFrom(polylines) {
  return { polylines, widthMm: 0, heightMm: 0 };
}

module.exports = {
  name: "paper layout placement",
  run(t) {
    t.check("auto-picks landscape for a wide drawing", (assert) => {
      const wide = drawingFrom([[{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 }]]);
      const result = layoutOnPaper(wide, PAPER);
      assert.strictEqual(result.orientation, "landscape");
    });

    t.check("auto-picks portrait for a tall drawing", (assert) => {
      const tall = drawingFrom([[{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 60 }]]);
      const result = layoutOnPaper(tall, PAPER);
      assert.strictEqual(result.orientation, "portrait");
    });

    t.check("keeps a small drawing at 1:1 by default (never enlarges)", (assert) => {
      const small = drawingFrom([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]]);
      const result = layoutOnPaper(small, PAPER);
      assert.ok(Math.abs(result.appliedScale - 1) < 1e-9, `appliedScale=${result.appliedScale}`);
      assert.ok(result.fillFraction < 1, "fillFraction below 1 because it isn't filling the sheet");
    });

    t.check("shrinks an oversized drawing to fit the padded area", (assert) => {
      const big = drawingFrom([[{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }]]);
      const result = layoutOnPaper(big, PAPER);
      // Landscape drawable 100×70: limiting axis is width → scale 0.5.
      assert.ok(Math.abs(result.appliedScale - 0.5) < 1e-9, `appliedScale=${result.appliedScale}`);
      assert.ok(Math.abs(result.fillFraction - 1) < 1e-9, "fills the sheet when it must shrink");
      assert.ok(Math.abs(result.contentWidthMm - 100) < 1e-6);
      assert.ok(Math.abs(result.contentHeightMm - 50) < 1e-6);
    });

    t.check("mirrors X so source-left lands on machine-right", (assert) => {
      const shape = drawingFrom([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]]);
      const result = layoutOnPaper(shape, PAPER); // scale 1, width 10
      const placed = result.drawing.polylines[0];
      assert.ok(Math.abs(placed[0].x - 10) < 1e-9, `mirrored first x=${placed[0].x}`);
      assert.ok(Math.abs(placed[1].x - 0) < 1e-9);
    });

    t.check("mirrorX=false leaves X unflipped", (assert) => {
      const shape = drawingFrom([[{ x: 0, y: 0 }, { x: 10, y: 0 }]]);
      const result = layoutOnPaper(shape, { ...PAPER, mirrorX: false });
      assert.ok(Math.abs(result.drawing.polylines[0][0].x - 0) < 1e-9);
    });

    t.check("anchors the placed drawing to the origin (bottom-right corner)", (assert) => {
      const shape = drawingFrom([[{ x: 5, y: 7 }, { x: 25, y: 7 }, { x: 25, y: 17 }]]);
      const result = layoutOnPaper(shape, PAPER);
      const box = boundingBox(result.drawing.polylines);
      assert.ok(Math.abs(box.minX) < 1e-9, `minX=${box.minX}`);
      assert.ok(Math.abs(box.minY) < 1e-9, `minY=${box.minY}`);
    });

    t.check("fillFraction override scales relative to the max fit", (assert) => {
      const big = drawingFrom([[{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }]]);
      const half = layoutOnPaper(big, { ...PAPER, fillFraction: 0.5 });
      // maxFit 0.5, half of that → 0.25.
      assert.ok(Math.abs(half.appliedScale - 0.25) < 1e-9, `appliedScale=${half.appliedScale}`);
    });

    t.check("default position anchors to the padded bottom-right corner", (assert) => {
      const shape = drawingFrom([[{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }]]);
      const result = layoutOnPaper(shape, PAPER); // portrait 90×120, pad 10, scale 1
      // Right edge of the box flush to (paperW - padding); bottom flush to (paperH - padding).
      assert.ok(Math.abs(result.positionXMm + result.contentWidthMm - (result.paperWidthMm - 10)) < 1e-6);
      assert.ok(Math.abs(result.positionYMm + result.contentHeightMm - (result.paperHeightMm - 10)) < 1e-6);
      assert.strictEqual(result.overflows, false);
    });

    t.check("explicit position drives the machine coordinates and flags overflow", (assert) => {
      const shape = drawingFrom([[{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }]]);
      // Push it into the top-left margin — should overflow the padded area.
      const result = layoutOnPaper(shape, { ...PAPER, positionXMm: 0, positionYMm: 0 });
      assert.strictEqual(result.overflows, true);
      const box = boundingBox(result.drawing.polylines);
      // Still produces finite machine coordinates (some negative — off the printable area).
      assert.ok(Number.isFinite(box.minX) && Number.isFinite(box.maxY));
    });

    t.check("machineToPaperView inverts the placement reflection", (assert) => {
      const shape = drawingFrom([[{ x: 3, y: 4 }, { x: 23, y: 4 }, { x: 23, y: 14 }]]);
      const result = layoutOnPaper(shape, PAPER);
      const paper = {
        paperWidthMm: result.paperWidthMm,
        paperHeightMm: result.paperHeightMm,
        paddingMm: result.paddingMm,
        mirrorX: result.mirrorX,
      };
      // The machine origin (0,0) maps to the start corner in the operator view.
      const origin = machineToPaperView(0, 0, paper);
      assert.ok(Math.abs(origin.xMm - (result.paperWidthMm - 10)) < 1e-6, `origin.x=${origin.xMm}`);
      assert.ok(Math.abs(origin.yMm - (result.paperHeightMm - 10)) < 1e-6, `origin.y=${origin.yMm}`);
    });
  },
};
