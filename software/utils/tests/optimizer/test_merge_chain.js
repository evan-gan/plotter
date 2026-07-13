"use strict";
// Stage 1 of the optimizer: endpoint snapping + greedy chaining.

const { mergeAndChain } = require("../../dist/optimizer");

module.exports = {
  name: "endpoint merge + chaining",
  run(t) {
    t.check("two segments sharing an endpoint chain into one", (assert) => {
      const chained = mergeAndChain(
        [
          [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          [{ x: 10.0001, y: 0 }, { x: 20, y: 0 }],
        ],
        0.3
      );
      assert.strictEqual(chained.length, 1);
      assert.strictEqual(chained[0].length, 3);
    });

    t.check("endpoints beyond tolerance stay separate", (assert) => {
      const chained = mergeAndChain(
        [
          [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          [{ x: 11, y: 0 }, { x: 20, y: 0 }],
        ],
        0.3
      );
      assert.strictEqual(chained.length, 2);
    });

    t.check("chains follow through reversed segments", (assert) => {
      // Middle segment is stored backwards; chaining must flip it.
      const chained = mergeAndChain(
        [
          [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          [{ x: 20, y: 0 }, { x: 10, y: 0 }],
          [{ x: 20, y: 0 }, { x: 30, y: 0 }],
        ],
        0.1
      );
      assert.strictEqual(chained.length, 1);
      // Chain direction is arbitrary at this stage (the tour orienter flips
      // later); either end-to-end order is correct.
      const xs = chained[0].map((point) => point.x);
      const acceptable = [[0, 10, 20, 30], [30, 20, 10, 0]];
      assert.ok(acceptable.some((option) => JSON.stringify(option) === JSON.stringify(xs)), `got ${xs}`);
    });

    t.check("a square of four loose edges becomes one closed loop", (assert) => {
      const chained = mergeAndChain(
        [
          [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          [{ x: 10, y: 0 }, { x: 10, y: 10 }],
          [{ x: 10, y: 10 }, { x: 0, y: 10 }],
          [{ x: 0, y: 10 }, { x: 0, y: 0 }],
        ],
        0.1
      );
      assert.strictEqual(chained.length, 1);
      assert.strictEqual(chained[0].length, 5);
    });

    t.check("three-way junction keeps at least one pen lift", (assert) => {
      // A T shape: three segments meeting at (0,0) — degree 3, so only two
      // can chain; the third must stay separate.
      const chained = mergeAndChain(
        [
          [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          [{ x: 0, y: 0 }, { x: -10, y: 0 }],
          [{ x: 0, y: 0 }, { x: 0, y: 10 }],
        ],
        0.1
      );
      assert.strictEqual(chained.length, 2);
      const totalPoints = chained.reduce((sum, line) => sum + line.length, 0);
      assert.strictEqual(totalPoints, 5); // 3-point chain + 2-point leftover
    });
  },
};
