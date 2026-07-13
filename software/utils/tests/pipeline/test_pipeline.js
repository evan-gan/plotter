"use strict";
// End-to-end pipelines: SVG → optimized G-code, and G-code → preview SVG.

const { prepareSvgPlot, prepareGcodePlot } = require("../../dist/pipeline");
const { gcodeToDrawing } = require("../../dist/gcode-parse");

module.exports = {
  name: "svg→gcode and gcode→svg pipelines",
  run(t) {
    const scatterSvg = `<svg xmlns="http://www.w3.org/2000/svg">
      <line x1="0" y1="0" x2="10" y2="0"/>
      <line x1="40" y1="40" x2="50" y2="40"/>
      <line x1="10" y1="0" x2="10" y2="10"/>
      <rect x="20" y="20" width="10" height="10"/>
    </svg>`;

    t.check("svg → optimized gcode parses back to the same stroke count", (assert) => {
      const prepared = prepareSvgPlot(scatterSvg, {
        svg: { fitWidthMm: 50, fitHeightMm: 50 },
        gcode: { feedMmMin: 1000 },
      });
      assert.ok(prepared.stats, "optimizer stats present");
      // Two touching lines chain; rect + far line stay → 3 strokes.
      assert.strictEqual(prepared.stats.penLiftsAfter, 3);
      const reparsed = gcodeToDrawing(prepared.gcode);
      assert.strictEqual(reparsed.polylines.length, 3);
      assert.ok(prepared.previewSvg.startsWith("<svg"));
    });

    t.check("optimize:false keeps document order", (assert) => {
      const prepared = prepareSvgPlot(scatterSvg, {
        svg: { fitWidthMm: 50, fitHeightMm: 50 },
        optimize: false,
      });
      assert.strictEqual(prepared.stats, null);
      const reparsed = gcodeToDrawing(prepared.gcode);
      assert.strictEqual(reparsed.polylines.length, 4); // nothing merged
    });

    t.check("gcode passthrough keeps the original program", (assert) => {
      const program = "G21 G90\nG0 X5 Y5\nM3\nG1 X15 Y5 F800\nM5\nG0 X0 Y0\n";
      const prepared = prepareGcodePlot(program, { optimize: false });
      assert.strictEqual(prepared.gcode, program);
      assert.strictEqual(prepared.drawing.polylines.length, 1);
      assert.ok(prepared.previewSvg.includes("<path"));
    });

    t.check("gcode re-optimization emits fresh gcode", (assert) => {
      const program = [
        "G21 G90",
        "M3", "G1 X10 Y0", "M5",
        "G0 X50 Y0", "M3", "G1 X60 Y0", "M5",
        "G0 X10 Y0", "M3", "G1 X20 Y0", "M5",
      ].join("\n");
      const prepared = prepareGcodePlot(program, { optimizer: { mergeToleranceMm: 0.3 } });
      assert.ok(prepared.stats.penLiftsAfter < 3, "chaining should reduce lifts");
    });
  },
};
