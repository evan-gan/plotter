"use strict";
// UnionFind: connectivity semantics used by endpoint clustering + greedy tour.

const { UnionFind } = require("../../dist/union-find");

module.exports = {
  name: "union-find connectivity",
  run(t) {
    t.check("union/connected/find behave transitively", (assert) => {
      const sets = new UnionFind(6);
      assert.strictEqual(sets.union(0, 1), true);
      assert.strictEqual(sets.union(1, 2), true);
      assert.strictEqual(sets.union(0, 2), false); // already merged
      assert.ok(sets.connected(0, 2));
      assert.ok(!sets.connected(0, 3));
      sets.union(3, 4);
      sets.union(2, 4);
      assert.ok(sets.connected(0, 3));
      assert.ok(!sets.connected(5, 0));
    });
  },
};
