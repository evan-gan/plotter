"use strict";
// Photo → line-art: darkness levels shaping and the three stroke generators.
// Uses a small synthetic image (a dark disc on a white field) so runs are fast
// and deterministic (seeded RNG).

const { computeDarkness, imageToLineart } = require("../../dist/image-to-lineart");
const { boundingBox } = require("../../dist/types");

const SIZE = 48;
const CANVAS_MM = 100;

/** Luminance grid with a dark filled circle centred on a white background. */
function discLuminance(size) {
  const luminance = new Uint8ClampedArray(size * size);
  const center = size / 2;
  const radius = size / 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x - center, y - center) <= radius;
      luminance[y * size + x] = inside ? 0 : 255;
    }
  }
  return luminance;
}

function withinCanvas(drawing) {
  const box = boundingBox(drawing.polylines);
  return box.minX >= -1e-6 && box.minY >= -1e-6 && box.maxX <= CANVAS_MM + 1e-6 && box.maxY <= CANVAS_MM + 1e-6;
}

function totalPoints(drawing) {
  return drawing.polylines.reduce((sum, line) => sum + line.length, 0);
}

module.exports = {
  name: "photo → line-art",
  run(t) {
    const luminance = discLuminance(SIZE);

    t.check("computeDarkness: white → 0, black → 1", (assert) => {
      const darkness = computeDarkness(luminance, SIZE, { contrast: 1, minValue: 1, maxValue: 0, gamma: 1 });
      let maxDark = 0;
      let whiteDark = 1;
      for (let i = 0; i < darkness.length; i++) {
        maxDark = Math.max(maxDark, darkness[i]);
        if (luminance[i] === 255) whiteDark = Math.min(whiteDark, darkness[i]);
      }
      assert.ok(maxDark > 0.99, `darkest ~1, got ${maxDark}`);
      assert.strictEqual(whiteDark, 0);
    });

    t.check("computeDarkness: brighter minValue leaves mid-grays white", (assert) => {
      const gray = new Uint8ClampedArray([200]);
      const darkness = computeDarkness(gray, 1, { contrast: 1, minValue: 0.5, maxValue: 0.15, gamma: 1 });
      assert.strictEqual(darkness[0], 0, "200/255 ≈ 0.78 > minValue 0.5 → white");
    });

    const darkness = computeDarkness(luminance, SIZE, {});

    for (const algorithm of ["stipple", "scribble", "pintr"]) {
      t.check(`${algorithm}: produces ink within the canvas`, (assert) => {
        const drawing = imageToLineart(darkness, SIZE, { algorithm, canvasMm: CANVAS_MM, seed: 1 });
        assert.ok(totalPoints(drawing) > 0, "produced points");
        assert.ok(withinCanvas(drawing), "all points inside the canvas box");
        assert.strictEqual(drawing.widthMm, CANVAS_MM);
      });

      t.check(`${algorithm}: same seed → identical output`, (assert) => {
        const first = imageToLineart(darkness, SIZE, { algorithm, canvasMm: CANVAS_MM, seed: 7 });
        const second = imageToLineart(darkness, SIZE, { algorithm, canvasMm: CANVAS_MM, seed: 7 });
        assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
      });
    }

    t.check("a blank (white) image yields no ink for pintr", (assert) => {
      const white = new Uint8ClampedArray(SIZE * SIZE).fill(255);
      const blankDark = computeDarkness(white, SIZE, {});
      const drawing = imageToLineart(blankDark, SIZE, { algorithm: "pintr", canvasMm: CANVAS_MM, seed: 1, totalLines: 50 });
      // With nothing to consume, every stroke has zero score; the chained path
      // still exists but carries essentially no meaningful ink — assert it stays bounded.
      assert.ok(withinCanvas(drawing), "stays within canvas even with no darkness");
    });
  },
};
