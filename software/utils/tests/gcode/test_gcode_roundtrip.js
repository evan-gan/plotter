"use strict";
// G-code generate/parse pair: a Drawing must survive the round trip, and the
// parser must honour modal state (units, relative mode, G92, arcs, pen).

const { drawingToGcode } = require("../../dist/gcode-generate");
const { gcodeToDrawing } = require("../../dist/gcode-parse");

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

module.exports = {
  name: "g-code generate + parse round trip",
  run(t) {
    t.check("drawing → gcode → drawing preserves geometry", (assert) => {
      const drawing = {
        polylines: [
          [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
          [{ x: 20, y: 20 }, { x: 30, y: 25 }],
        ],
        widthMm: 30,
        heightMm: 25,
      };
      const gcode = drawingToGcode(drawing, { feedMmMin: 1200 });
      const parsed = gcodeToDrawing(gcode);
      assert.strictEqual(parsed.polylines.length, 2);
      parsed.polylines.forEach((line, lineIndex) => {
        drawing.polylines[lineIndex].forEach((expected, pointIndex) => {
          assert.ok(near(line[pointIndex].x, expected.x) && near(line[pointIndex].y, expected.y),
            `line ${lineIndex} point ${pointIndex}`);
        });
      });
    });

    t.check("generated gcode contains pen + feed commands", (assert) => {
      const gcode = drawingToGcode(
        { polylines: [[{ x: 0, y: 0 }, { x: 5, y: 5 }]], widthMm: 5, heightMm: 5 },
        { feedMmMin: 900, penSettleMs: 120 }
      );
      assert.ok(gcode.includes("G1 F900"));
      assert.ok(gcode.includes("M3"));
      assert.ok(gcode.includes("M5"));
      assert.ok(gcode.includes("G4 P120"));
      assert.ok(gcode.trim().split("\n").pop().startsWith("G0 X0 Y0"));
    });

    t.check("parser: relative mode and G92 offsets", (assert) => {
      const program = [
        "G21 G90", "G0 X10 Y10", "G92 X0 Y0", // logical origin now at (10,10)
        "M3", "G91", "G1 X5 Y0", "G1 X0 Y5", "M5",
      ].join("\n");
      const drawing = gcodeToDrawing(program);
      assert.strictEqual(drawing.polylines.length, 1);
      const [line] = drawing.polylines;
      // Machine frame: starts at (10,10) → (15,10) → (15,15).
      assert.ok(near(line[0].x, 10) && near(line[0].y, 10));
      assert.ok(near(line[2].x, 15) && near(line[2].y, 15));
    });

    t.check("parser: G20 inches scale to mm", (assert) => {
      const drawing = gcodeToDrawing("G20 G90\nM3\nG1 X1 Y0\nM5");
      const [line] = drawing.polylines;
      assert.ok(near(line[1].x, 25.4));
    });

    t.check("parser: G2 arc flattens to a circle's worth of points", (assert) => {
      const program = "G21 G90\nG0 X10 Y0\nM3\nG2 X10 Y0 I0 J10\nM5";
      const drawing = gcodeToDrawing(program, 0.01);
      const [line] = drawing.polylines;
      assert.ok(line.length > 12, `expected many segments, got ${line.length}`);
      for (const point of line) {
        const radius = Math.hypot(point.x - 10, point.y - 10);
        assert.ok(Math.abs(radius - 10) < 0.06, `radius ${radius}`);
      }
    });

    t.check("parser: pen-up rapids draw nothing", (assert) => {
      const drawing = gcodeToDrawing("G21 G90\nG0 X50 Y50\nG0 X0 Y0\nM3\nG1 X1 Y1\nM5");
      assert.strictEqual(drawing.polylines.length, 1);
      assert.strictEqual(drawing.polylines[0].length, 2);
    });
  },
};
