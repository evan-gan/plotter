"use strict";
// Whole-document SVG parsing: shapes, groups/transforms, defs skipping,
// work-area fitting and the Y flip into the plotter frame.

const { svgToDrawing } = require("../../dist/svg-parse");

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

module.exports = {
  name: "svg document → drawing",
  run(t) {
    t.check("rect becomes a closed polyline, fitted and Y-flipped", (assert) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="5"/></svg>`;
      const drawing = svgToDrawing(svg, { fitWidthMm: 100, fitHeightMm: 100 });
      assert.strictEqual(drawing.polylines.length, 1);
      // 10x5 fitted into 100x100 → scale 10 → 100x50 mm.
      assert.ok(near(drawing.widthMm, 100) && near(drawing.heightMm, 50), `${drawing.widthMm}x${drawing.heightMm}`);
      // SVG top edge (y=0) must land at the TOP of the plotter frame (y=50).
      const ys = drawing.polylines[0].map((point) => point.y);
      assert.ok(near(Math.max(...ys), 50) && near(Math.min(...ys), 0));
    });

    t.check("nested group transforms compose", (assert) => {
      const svg = `<svg><g transform="translate(10 0)"><g transform="scale(2)">
        <line x1="0" y1="0" x2="5" y2="0"/></g></g>
        <line x1="0" y1="0" x2="20" y2="0"/></svg>`;
      const drawing = svgToDrawing(svg, { fitWidthMm: 20, fitHeightMm: 20 });
      // Line A: from (10,0) to (20,0); line B: (0,0)-(20,0). Width = 20 user
      // units → scale 1 → widths preserved.
      assert.strictEqual(drawing.polylines.length, 2);
      const lineA = drawing.polylines[0];
      assert.ok(near(lineA[0].x, 10) && near(lineA[1].x, 20), `${lineA[0].x}..${lineA[1].x}`);
    });

    t.check("rotate(90) turns a horizontal line vertical", (assert) => {
      const svg = `<svg><g transform="rotate(90)"><line x1="0" y1="0" x2="10" y2="0"/></g></svg>`;
      const drawing = svgToDrawing(svg, { fitWidthMm: 50, fitHeightMm: 50 });
      const [line] = drawing.polylines;
      assert.ok(near(line[0].x, line[1].x, 1e-3), "line should be vertical after rotate");
    });

    t.check("defs/clipPath content is not drawn", (assert) => {
      const svg = `<svg><defs><rect x="0" y="0" width="5" height="5"/></defs>
        <circle cx="10" cy="10" r="4"/></svg>`;
      const drawing = svgToDrawing(svg, { fitWidthMm: 40, fitHeightMm: 40 });
      assert.strictEqual(drawing.polylines.length, 1); // only the circle
    });

    t.check("circle is closed and round", (assert) => {
      const svg = `<svg><circle cx="0" cy="0" r="10"/></svg>`;
      const drawing = svgToDrawing(svg, { fitWidthMm: 20, fitHeightMm: 20 });
      const [line] = drawing.polylines;
      const first = line[0];
      const last = line[line.length - 1];
      assert.ok(near(first.x, last.x) && near(first.y, last.y), "circle closed");
      // Every point ~10mm from the centre (10,10) after fitting 20x20.
      for (const point of line) {
        const radius = Math.hypot(point.x - 10, point.y - 10);
        assert.ok(Math.abs(radius - 10) < 0.15, `radius ${radius}`);
      }
    });

    t.check("polygon closes itself, polyline does not", (assert) => {
      const svg = `<svg><polygon points="0,0 10,0 10,10"/><polyline points="20,0 30,0 30,10"/></svg>`;
      const drawing = svgToDrawing(svg, { fitWidthMm: 30, fitHeightMm: 30 });
      const [polygon, polyline] = drawing.polylines;
      assert.strictEqual(polygon.length, 4);
      assert.strictEqual(polyline.length, 3);
    });

    t.check("many polylines all survive dedupe (map-index-as-epsilon regression)", (assert) => {
      // Regression: `map(dedupeConsecutive)` passed the array index as epsilon,
      // collapsing every polyline past the first few into a single point.
      const shapes = [];
      for (let i = 0; i < 200; i++) {
        shapes.push(`<polyline points="${i},0 ${i},1 ${i},2"/>`);
      }
      const drawing = svgToDrawing(`<svg>${shapes.join("")}</svg>`, { fitWidthMm: 200, fitHeightMm: 200 });
      assert.strictEqual(drawing.polylines.length, 200);
      for (const line of drawing.polylines) assert.strictEqual(line.length, 3);
    });

    t.check("empty svg throws a useful error", (assert) => {
      assert.throws(() => svgToDrawing("<svg><text>hi</text></svg>"), /no drawable geometry/);
    });
  },
};
