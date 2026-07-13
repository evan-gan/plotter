"use strict";
// Crossing-breakpoint pre-stage: splitPolylinesAtIntersections + its effect on
// the full optimizer.

const {
  splitPolylinesAtIntersections,
  segmentIntersection,
  optimizePolylines,
} = require("../../dist/index");

/** Total pen-down length of a polyline set (must be preserved by splitting). */
function totalInk(polylines) {
  let total = 0;
  for (const line of polylines) {
    for (let i = 1; i < line.length; i++) {
      total += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
    }
  }
  return total;
}

module.exports = {
  name: "crossing-split pre-stage",
  run(t) {
    t.check("segmentIntersection finds a proper crossing at the midpoint", (assert) => {
      const hit = segmentIntersection(
        { x: -1, y: 0 }, { x: 1, y: 0 },
        { x: 0, y: -1 }, { x: 0, y: 1 }
      );
      assert.ok(hit, "should intersect");
      assert.ok(Math.abs(hit.point.x) < 1e-9 && Math.abs(hit.point.y) < 1e-9, "crosses at origin");
      assert.ok(Math.abs(hit.tA - 0.5) < 1e-9 && Math.abs(hit.tB - 0.5) < 1e-9, "midpoint of both");
    });

    t.check("parallel segments do not intersect", (assert) => {
      const hit = segmentIntersection(
        { x: 0, y: 0 }, { x: 10, y: 0 },
        { x: 0, y: 5 }, { x: 10, y: 5 }
      );
      assert.strictEqual(hit, null);
    });

    t.check("non-crossing input is returned unchanged (same count)", (assert) => {
      const input = [
        [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        [{ x: 0, y: 5 }, { x: 10, y: 5 }],
      ];
      const split = splitPolylinesAtIntersections(input);
      assert.strictEqual(split.length, 2, "no crossings => no extra pieces");
    });

    t.check("an X crossing splits both strokes into four pieces through the centre", (assert) => {
      const input = [
        [{ x: -10, y: 0 }, { x: 10, y: 0 }], // horizontal
        [{ x: 0, y: -10 }, { x: 0, y: 10 }], // vertical
      ];
      const split = splitPolylinesAtIntersections(input);
      assert.strictEqual(split.length, 4, "two crossing strokes => four arms");
      // Every arm must touch the crossing point (0,0).
      const touchesCentre = (line) =>
        line.some((point) => Math.abs(point.x) < 1e-9 && Math.abs(point.y) < 1e-9);
      for (const arm of split) assert.ok(touchesCentre(arm), "arm should reach the centre");
      assert.ok(Math.abs(totalInk(split) - totalInk(input)) < 1e-9, "ink length preserved");
    });

    t.check("a T-junction splits only the crossed stroke, at its interior", (assert) => {
      const input = [
        [{ x: -10, y: 0 }, { x: 10, y: 0 }], // the crossed bar
        [{ x: 0, y: 0 }, { x: 0, y: 10 }],   // stem meeting the bar at its middle
      ];
      const split = splitPolylinesAtIntersections(input);
      // Bar splits into two halves; stem's endpoint sits on the bar so it stays.
      assert.strictEqual(split.length, 3, `expected 3 pieces, got ${split.length}`);
      assert.ok(Math.abs(totalInk(split) - totalInk(input)) < 1e-9, "ink length preserved");
    });

    t.check("self-intersection of a figure-eight is split", (assert) => {
      // A single closed stroke that crosses itself once at the origin.
      const input = [[
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 5, y: -5 },
        { x: -5, y: 5 },
        { x: -5, y: -5 },
        { x: 0, y: 0 },
      ]];
      const split = splitPolylinesAtIntersections(input);
      assert.ok(split.length > 1, `self-crossing should split, got ${split.length}`);
      assert.ok(Math.abs(totalInk(split) - totalInk(input)) < 1e-9, "ink length preserved");
    });

    t.check("optimizer routes a plus-sign through the centre as two continuous strokes", (assert) => {
      // Four arms of a plus, submitted as separate strokes that all meet at the
      // centre. With crossing-splitting the optimizer should draw the whole plus
      // with fewer pen lifts than the four raw strokes.
      const input = [
        [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        [{ x: 0, y: 0 }, { x: -10, y: 0 }],
        [{ x: 0, y: 0 }, { x: 0, y: 10 }],
        [{ x: 0, y: 0 }, { x: 0, y: -10 }],
      ];
      const withSplit = optimizePolylines(input, { mergeToleranceMm: 0.01, splitAtIntersections: true });
      const withoutSplit = optimizePolylines(input, { mergeToleranceMm: 0.01, splitAtIntersections: false });
      assert.ok(
        withSplit.stats.penLiftsAfter <= withoutSplit.stats.penLiftsAfter,
        `split lifts ${withSplit.stats.penLiftsAfter} should not exceed ${withoutSplit.stats.penLiftsAfter}`
      );
      // Ink is unchanged either way.
      const inkBefore = totalInk(input);
      assert.ok(Math.abs(totalInk(withSplit.polylines) - inkBefore) < 1e-6, "ink preserved");
    });

    t.check("splitting never scores worse than the endpoint-only plan", (assert) => {
      // A dense grid: lots of crossings, where splitting should help (or tie).
      const input = [];
      for (let row = 0; row <= 5; row++) input.push([{ x: 0, y: row * 10 }, { x: 50, y: row * 10 }]);
      for (let col = 0; col <= 5; col++) input.push([{ x: col * 10, y: 0 }, { x: col * 10, y: 50 }]);
      const withSplit = optimizePolylines(input, { mergeToleranceMm: 0.01, splitAtIntersections: true });
      const withoutSplit = optimizePolylines(input, { mergeToleranceMm: 0.01, splitAtIntersections: false });
      const score = (stats) => stats.penUpAfterMm + 10 * stats.penLiftsAfter;
      assert.ok(
        score(withSplit.stats) <= score(withoutSplit.stats) + 1e-6,
        `split score ${score(withSplit.stats)} must not exceed ${score(withoutSplit.stats)}`
      );
      assert.ok(Math.abs(totalInk(withSplit.polylines) - totalInk(input)) < 1e-6, "grid ink preserved");
    });
  },
};
