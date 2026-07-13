"use strict";
// Stages 2–4: tour construction + 2-opt/Or-opt improvement + orientation DP.

const { optimizePolylines } = require("../../dist/optimizer");
const { penUpDistance } = require("../../dist/types");

/** Deterministic LCG so failures reproduce. */
function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
}

module.exports = {
  name: "tour optimization",
  run(t) {
    t.check("keeps every polyline exactly once", (assert) => {
      const random = makeRandom(7);
      const input = Array.from({ length: 40 }, () => {
        const x = random() * 100, y = random() * 100;
        return [{ x, y }, { x: x + 2, y: y + 2 }];
      });
      const { polylines } = optimizePolylines(input, { mergeToleranceMm: 0.01 });
      assert.strictEqual(polylines.length, 40);
      // Every input segment must appear (in either orientation).
      const key = (line) => {
        const forward = line.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(";");
        const backward = [...line].reverse().map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(";");
        return forward < backward ? forward : backward;
      };
      const inputKeys = new Set(input.map(key));
      for (const line of polylines) assert.ok(inputKeys.has(key(line)), "output line not from input");
    });

    t.check("never increases pen-up distance on random scatter", (assert) => {
      const random = makeRandom(1234);
      const input = Array.from({ length: 120 }, () => {
        const x = random() * 200, y = random() * 200;
        const angle = random() * Math.PI * 2;
        return [{ x, y }, { x: x + 5 * Math.cos(angle), y: y + 5 * Math.sin(angle) }];
      });
      const before = penUpDistance(input);
      const { stats } = optimizePolylines(input, { mergeToleranceMm: 0.01 });
      assert.ok(stats.penUpAfterMm <= before + 1e-6, `${stats.penUpAfterMm} vs ${before}`);
      // Random order is terrible; the optimizer should do far better.
      assert.ok(stats.penUpAfterMm < before * 0.5, `only reached ${stats.penUpAfterMm} of ${before}`);
    });

    t.check("shuffled grid rows return to near-perfect order", (assert) => {
      // 20 horizontal strokes on consecutive rows, submitted shuffled. The
      // ideal boustrophedon plot needs ~19 × 2 mm of hops (plus reaching row
      // 0 from origin); accept a small slack over that.
      const rows = Array.from({ length: 20 }, (_, row) => [
        { x: 0, y: row * 2 }, { x: 50, y: row * 2 },
      ]);
      const random = makeRandom(99);
      const shuffled = [...rows].sort(() => random() - 0.5);
      const { stats, polylines } = optimizePolylines(shuffled, { mergeToleranceMm: 0.01 });
      assert.strictEqual(polylines.length, 20);
      assert.ok(stats.penUpAfterMm < 60, `pen-up after: ${stats.penUpAfterMm}`);
    });

    t.check("orientation DP starts at the end nearest the origin", (assert) => {
      const input = [[{ x: 100, y: 100 }, { x: 1, y: 1 }]];
      const { polylines } = optimizePolylines(input);
      // Reversal is free; drawing should start at the (1,1) end.
      assert.ok(polylines[0][0].x === 1, "polyline should be reversed to start near origin");
    });

    t.check("connected square + far segment: square merges, order sane", (assert) => {
      const input = [
        [{ x: 60, y: 60 }, { x: 70, y: 60 }],
        [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        [{ x: 10, y: 0 }, { x: 10, y: 10 }],
        [{ x: 10, y: 10 }, { x: 0, y: 10 }],
        [{ x: 0, y: 10 }, { x: 0, y: 0 }],
      ];
      const { polylines, stats } = optimizePolylines(input, { mergeToleranceMm: 0.1 });
      assert.strictEqual(polylines.length, 2);
      assert.strictEqual(stats.penLiftsAfter, 2);
      // Square (near origin) must be drawn before the far segment.
      assert.ok(polylines[0].length === 5, "square first, as one closed chain");
    });

    t.check("empty and single-line inputs pass through", (assert) => {
      assert.strictEqual(optimizePolylines([]).polylines.length, 0);
      const single = optimizePolylines([[{ x: 0, y: 0 }, { x: 5, y: 5 }]]);
      assert.strictEqual(single.polylines.length, 1);
    });
  },
};
