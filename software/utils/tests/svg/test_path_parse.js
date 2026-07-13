"use strict";
// SVG path-data parsing: commands, relative coords, curves, arcs, arc flags.

const { parsePathData } = require("../../dist/svg-path");

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

module.exports = {
  name: "svg path data parser",
  run(t) {
    t.check("M/L/Z absolute + close", (assert) => {
      const lines = parsePathData("M0 0 L10 0 L10 10 Z");
      assert.strictEqual(lines.length, 1);
      const line = lines[0];
      assert.deepStrictEqual(line[0], { x: 0, y: 0 });
      assert.deepStrictEqual(line[line.length - 1], { x: 0, y: 0 }); // closed
      assert.strictEqual(line.length, 4);
    });

    t.check("relative commands and implicit lineto after m", (assert) => {
      const lines = parsePathData("m5 5 10 0 0 10");
      assert.strictEqual(lines.length, 1);
      assert.deepStrictEqual(lines[0], [
        { x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 },
      ]);
    });

    t.check("H/V shorthands", (assert) => {
      const [line] = parsePathData("M1 2 H5 V7 h-2 v-3");
      assert.deepStrictEqual(line, [
        { x: 1, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 7 }, { x: 3, y: 7 }, { x: 3, y: 4 },
      ]);
    });

    t.check("cubic bezier flattens near the true curve", (assert) => {
      const [line] = parsePathData("M0 0 C 0 10, 10 10, 10 0", 0.05);
      assert.ok(line.length > 4, `expected several segments, got ${line.length}`);
      const last = line[line.length - 1];
      assert.ok(near(last.x, 10) && near(last.y, 0));
      // Curve apex for this symmetric cubic is y = 7.5 at x = 5.
      const apex = line.reduce((best, point) => (point.y > best.y ? point : best));
      assert.ok(Math.abs(apex.y - 7.5) < 0.2, `apex ${apex.y}`);
    });

    t.check("smooth cubic (S) reflects the previous control point", (assert) => {
      const [smooth] = parsePathData("M0 0 C 0 5, 5 5, 5 0 S 10 -5, 10 0", 0.02);
      const last = smooth[smooth.length - 1];
      assert.ok(near(last.x, 10) && near(last.y, 0));
      // Reflection makes the second lobe dip negative (mirror of the first).
      const dip = Math.min(...smooth.map((point) => point.y));
      assert.ok(dip < -3, `expected mirrored dip, got ${dip}`);
    });

    t.check("quadratic + T shorthand", (assert) => {
      const [line] = parsePathData("M0 0 Q 5 10 10 0 T 20 0", 0.02);
      const last = line[line.length - 1];
      assert.ok(near(last.x, 20) && near(last.y, 0));
    });

    t.check("arc lands on its endpoint and bulges the right way", (assert) => {
      const [line] = parsePathData("M0 0 A 5 5 0 0 1 10 0", 0.02);
      const last = line[line.length - 1];
      assert.ok(near(last.x, 10) && near(last.y, 0));
      // sweep=1 in Y-down SVG space bulges toward negative Y.
      const extremeY = Math.min(...line.map((point) => point.y));
      assert.ok(extremeY < -4.5, `expected ~-5 bulge, got ${extremeY}`);
    });

    t.check("arc flags glued to the next number parse (…0 0150 0)", (assert) => {
      // "0150 0" must lex as flag 0, flag 1, x=50, y=0 — flags are single
      // digits per the SVG grammar even with no separator after them.
      const lines = parsePathData("M0 0 A25 25 0 0150 0");
      const [line] = lines;
      const last = line[line.length - 1];
      assert.ok(near(last.x, 50) && near(last.y, 0), `end ${last.x},${last.y}`);
    });

    t.check("multiple subpaths become multiple polylines", (assert) => {
      const lines = parsePathData("M0 0 L1 0 M5 5 L6 5 L6 6");
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[1].length, 3);
    });
  },
};
