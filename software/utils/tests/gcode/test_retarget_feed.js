"use strict";
// retargetDrawFeed: rewrite the draw feed of our generated gcode in place, and
// refuse to touch authored gcode (which may carry its own per-move feeds).

const { drawingToGcode, retargetDrawFeed, GENERATED_MARKER } = require("../../dist/gcode-generate");

const SAMPLE_DRAWING = {
  polylines: [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    [{ x: 20, y: 20 }, { x: 30, y: 25 }],
  ],
  widthMm: 30,
  heightMm: 25,
};

module.exports = {
  name: "retargetDrawFeed — refeed generated gcode",
  run(t) {
    t.check("rewrites our generated gcode to the new feed", (assert) => {
      const original = drawingToGcode(SAMPLE_DRAWING, { feedMmMin: 1500 });
      const refed = retargetDrawFeed(original, 6000);
      assert.ok(refed !== null, "should recognise our own gcode");
      assert.ok(refed.includes("G1 F6000"), "new feed present");
      assert.ok(!refed.includes("G1 F1500"), "old feed gone");
    });

    t.check("changes only the single feed header, not draw moves or geometry", (assert) => {
      const original = drawingToGcode(SAMPLE_DRAWING, { feedMmMin: 1500 });
      const refed = retargetDrawFeed(original, 6000);
      // Exactly one line sets the feed; every other line is byte-identical.
      const feedLines = refed.split("\n").filter((line) => /^G1 F\d/.test(line));
      assert.strictEqual(feedLines.length, 1, "still exactly one feed header");
      const before = original.split("\n");
      const after = refed.split("\n");
      assert.strictEqual(before.length, after.length, "line count unchanged");
      const changed = before.filter((line, index) => line !== after[index]);
      assert.strictEqual(changed.length, 1, "only the feed line changed");
      assert.ok(changed[0] === "G1 F1500", "the changed line was the feed header");
    });

    t.check("preserves a trailing comment on the feed line", (assert) => {
      const gcode = `${GENERATED_MARKER}\nG1 F1500 ; draw\nG1 X5 Y5\n`;
      const refed = retargetDrawFeed(gcode, 3000);
      assert.ok(refed.includes("G1 F3000 ; draw"), "comment kept");
    });

    t.check("returns null for authored gcode (no marker)", (assert) => {
      const authored = "G21 G90\nG1 F1500\nG1 X5 Y5 F2000\nM5\n";
      assert.strictEqual(retargetDrawFeed(authored, 6000), null);
    });

    t.check("null when marker present but no feed header to rewrite", (assert) => {
      const noFeed = `${GENERATED_MARKER}\nG21 G90\nG0 X0 Y0\n`;
      assert.strictEqual(retargetDrawFeed(noFeed, 6000), null);
    });
  },
};
