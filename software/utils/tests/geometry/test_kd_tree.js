"use strict";
// KdTree: radius queries and k-nearest results must match brute force.

const { KdTree } = require("../../dist/kd-tree");

function bruteNearest(points, target, k, skip) {
  return points
    .map((point, index) => ({ index, d: Math.hypot(point.x - target.x, point.y - target.y) }))
    .filter((entry) => !skip || !skip(entry.index))
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((entry) => entry.index);
}

module.exports = {
  name: "k-d tree matches brute-force search",
  run(t) {
    // Deterministic pseudo-random points (LCG) so failures reproduce.
    let seed = 42;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const points = Array.from({ length: 400 }, () => ({ x: random() * 100, y: random() * 100 }));
    const tree = new KdTree(points);

    t.check("withinRadius matches brute force", (assert) => {
      for (const target of [{ x: 10, y: 10 }, { x: 50, y: 99 }, { x: 0, y: 0 }]) {
        const expected = points
          .map((point, index) => ({ index, d: Math.hypot(point.x - target.x, point.y - target.y) }))
          .filter((entry) => entry.d <= 7)
          .map((entry) => entry.index)
          .sort((a, b) => a - b);
        const actual = tree.withinRadius(target, 7).sort((a, b) => a - b);
        assert.deepStrictEqual(actual, expected);
      }
    });

    t.check("nearest(k) matches brute force distances", (assert) => {
      for (const target of [{ x: 25, y: 75 }, { x: 90, y: 5 }]) {
        const expected = bruteNearest(points, target, 10);
        const actual = tree.nearest(target, 10);
        const distanceOf = (index) => Math.hypot(points[index].x - target.x, points[index].y - target.y);
        assert.deepStrictEqual(actual.map(distanceOf), expected.map(distanceOf));
      }
    });

    t.check("nearest honours the skip filter", (assert) => {
      const skip = (index) => index % 2 === 0;
      const actual = tree.nearest({ x: 50, y: 50 }, 5, skip);
      assert.ok(actual.every((index) => index % 2 === 1));
      assert.strictEqual(actual.length, 5);
    });
  },
};
