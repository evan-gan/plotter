"use strict";
// Host-side tests for the ETA estimator. No serial or hardware needed — these
// exercise the parser and timing engine against hand-computed analytic cases.
//
// Run with:  node test/run_all.js   (or `pnpm test` from firmware/tools)

const assert = require("assert");
const { parseGcode } = require("../lib/gcode-parser");
const { estimateEta, trapezoidTime, motorLoad, DEFAULT_CONFIG, configFromSettings } = require("../lib/eta-engine");
const { leastSquares2, deriveCalibration, timeProgram, buildCalibrationTests } = require("../lib/calibrate");

let passed = 0;
let failed = 0;

/** Run one named synchronous assertion, tracking pass/fail counts. */
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

/** Run one named async assertion (awaits the promise). */
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

/** Assert two numbers are within `tolerance` of each other. */
function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ~${expected}, got ${actual}`);
}

// ── motor-load factor (layout-independent CoreXY) ──
test("motorLoad is 1 along pure X and pure Y", () => {
  assertClose(motorLoad(1, 0), 1, 1e-9, "pure X");
  assertClose(motorLoad(0, 1), 1, 1e-9, "pure Y");
});
test("motorLoad is √2 at 45°", () => {
  const diag = Math.SQRT1_2;
  assertClose(motorLoad(diag, diag), Math.SQRT2, 1e-9, "45°");
});

// ── trapezoid timing: a symmetric accel/decel that never cruises ──
test("triangle profile time matches closed form", () => {
  // 10 mm, start/end at rest, a = 200 mm/s². Peak = sqrt(a*L) = sqrt(2000).
  // Symmetric: t = 2 * v_peak / a.
  const block = { length: 10, entrySpeed: 0, nominalSpeed: 1e9, acceleration: 200 };
  const peak = Math.sqrt(200 * 10);
  assertClose(trapezoidTime(block, 0), (2 * peak) / 200, 1e-6, "triangle time");
});

// ── trapezoid timing: reaches nominal and cruises ──
test("trapezoid with cruise matches closed form", () => {
  // 100 mm at nominal 25 mm/s, a = 200. Accel dist = v²/2a = 625/400 = 1.5625.
  // Two ramps + cruise: t = 2*(v/a) + (L - 2*d_accel)/v.
  const nominal = 25;
  const accel = 200;
  const block = { length: 100, entrySpeed: 0, nominalSpeed: nominal, acceleration: accel };
  const distAccel = (nominal * nominal) / (2 * accel);
  const expected = (2 * nominal) / accel + (100 - 2 * distAccel) / nominal;
  assertClose(trapezoidTime(block, 0), expected, 1e-6, "trapezoid time");
});

// ── parser: a straight G1 line in mm ──
test("parses a single G1 move", () => {
  const primitives = parseGcode("G21\nG90\nG1 X10 Y0 F600\n", 0.002);
  assert.strictEqual(primitives.length, 1);
  assert.strictEqual(primitives[0].type, "move");
  assertClose(primitives[0].x, 10, 1e-9, "target X");
  assertClose(primitives[0].feedMmMin, 600, 1e-9, "feed");
});

// ── parser: inch mode scales coordinates ──
test("G20 scales inches to mm", () => {
  const primitives = parseGcode("G20\nG90\nG1 X1 Y0 F60\n", 0.002);
  assertClose(primitives[0].x, 25.4, 1e-9, "1 inch → 25.4 mm");
});

// ── parser: relative mode accumulates ──
test("G91 relative moves accumulate", () => {
  const primitives = parseGcode("G21\nG91\nG1 X5\nG1 X5\n", 0.002);
  assertClose(primitives[1].x, 10, 1e-9, "second move absolute X");
});

// ── parser: M3/M5 and G4 become pen/dwell primitives ──
test("pen and dwell primitives are emitted", () => {
  const primitives = parseGcode("M3 S1700\nG4 P250\nM5\n", 0.002);
  assert.strictEqual(primitives.filter((p) => p.type === "pen").length, 2);
  const dwell = primitives.find((p) => p.type === "dwell");
  assertClose(dwell.ms, 250, 1e-9, "G4 P is milliseconds in this firmware");
});

// ── parser: arcs flatten into multiple segments ──
test("G2 arc flattens into many segments ending on target", () => {
  // Quarter circle, radius 20 mm, from (20,0) around centre (0,0) to (0,20).
  const src = "G21\nG90\nG1 X20 Y0 F600\nG2 X0 Y20 I-20 J0\n";
  const primitives = parseGcode(src, 0.002);
  const arcSegments = primitives.slice(1); // drop the initial G1
  assert(arcSegments.length > 5, `expected several segments, got ${arcSegments.length}`);
  const last = arcSegments[arcSegments.length - 1];
  assertClose(last.x, 0, 1e-6, "arc ends at target X");
  assertClose(last.y, 20, 1e-6, "arc ends at target Y");
});

// ── end-to-end: single long move ETA vs. closed form ──
test("ETA of one 100 mm move matches trapezoid closed form", () => {
  const config = configFromSettings(null); // firmware defaults
  const primitives = parseGcode("G21\nG90\nG1 X100 Y0 F1500\n", config.arcToleranceMm);
  const result = estimateEta(primitives, config);
  const nominal = config.maxFeedrateMmMin / 60; // 25 mm/s
  const accel = config.maxAccelMmS2; // 200 mm/s²
  const distAccel = (nominal * nominal) / (2 * accel);
  const expected = (2 * nominal) / accel + (100 - 2 * distAccel) / nominal;
  assertClose(result.seconds, expected, 1e-3, "single-move ETA");
  assertClose(result.drawDistanceMm, 100, 1e-6, "draw distance");
});

// ── end-to-end: pen lifts add fixed dwell time ──
test("pen lifts contribute fixed dwell to the ETA", () => {
  const config = configFromSettings(null);
  const primitives = parseGcode("M3\nG1 X10 F600\nM5\n", config.arcToleranceMm);
  const result = estimateEta(primitives, config);
  assertClose(result.fixedSeconds, (2 * config.penMoveMs) / 1000, 1e-9, "two lifts × penMoveMs");
});

// ── calibration knobs feed through the estimator ──
test("motionScaler and overheadPerMoveMs scale the ETA", () => {
  const primitives = parseGcode("G21\nG90\nG1 X100 Y0 F1500\n", 0.002);
  const base = configFromSettings(null);
  const baseline = estimateEta(primitives, base);
  const scaled = estimateEta(primitives, configFromSettings(null, { motionScaler: 2, overheadPerMoveMs: 100 }));
  assertClose(scaled.calibratedMotionSeconds, 2 * baseline.motionSeconds, 1e-6, "2× motion");
  assertClose(scaled.overheadSeconds, 0.1 * baseline.moveCount, 1e-9, "overhead per move");
  assertClose(scaled.seconds, 2 * baseline.motionSeconds + 0.1 * baseline.moveCount + baseline.fixedSeconds, 1e-6, "total");
});

// ── configFromSettings merges an overrides object and legacy number ──
test("configFromSettings accepts overrides object and legacy penMoveMs number", () => {
  const fromObject = configFromSettings(null, { penMoveMs: 200, motionScaler: 1.3 });
  assertClose(fromObject.penMoveMs, 200, 1e-9, "object penMoveMs");
  assertClose(fromObject.motionScaler, 1.3, 1e-9, "object motionScaler");
  const fromNumber = configFromSettings(null, 250);
  assertClose(fromNumber.penMoveMs, 250, 1e-9, "legacy number penMoveMs");
  assertClose(fromNumber.motionScaler, 1, 1e-9, "legacy leaves scaler default");
});

// ── least-squares solver recovers exact coefficients ──
test("leastSquares2 recovers known a and b", () => {
  const trueA = 1.25;
  const trueB = 0.006;
  const samples = [
    { x1: 4, x2: 40 },
    { x1: 9, x2: 12 },
    { x1: 2, x2: 90 },
  ].map((s) => ({ ...s, y: trueA * s.x1 + trueB * s.x2 }));
  const fit = leastSquares2(samples);
  assertClose(fit.a, trueA, 1e-6, "recovered a");
  assertClose(fit.b, trueB, 1e-6, "recovered b");
});

test("leastSquares2 returns null when singular", () => {
  const samples = [{ x1: 1, x2: 2, y: 3 }, { x1: 2, x2: 4, y: 6 }]; // x2 = 2·x1
  assert.strictEqual(leastSquares2(samples), null);
});

// ── deriveCalibration recovers injected knobs from synthetic runs ──
test("deriveCalibration recovers motionScaler, overhead, and penMoveMs", () => {
  const trueScaler = 1.2;
  const trueOverheadSec = 0.005; // 5 ms/move
  const truePenMs = 170;
  const motionRows = [
    { group: "motion", rawMotionSeconds: 5, moveCount: 30, penLifts: 0 },
    { group: "motion", rawMotionSeconds: 12, moveCount: 6, penLifts: 0 },
    { group: "motion", rawMotionSeconds: 3, moveCount: 80, penLifts: 0 },
  ].map((r) => ({ ...r, actualSeconds: trueScaler * r.rawMotionSeconds + trueOverheadSec * r.moveCount }));
  const penRow = { group: "pen", rawMotionSeconds: 0.02, moveCount: 0, penLifts: 10 };
  penRow.actualSeconds = penRow.rawMotionSeconds + (truePenMs / 1000) * penRow.penLifts;

  const cal = deriveCalibration([...motionRows, penRow], DEFAULT_CONFIG);
  assertClose(cal.motionScaler, trueScaler, 1e-3, "motionScaler");
  assertClose(cal.overheadPerMoveMs, trueOverheadSec * 1000, 1e-2, "overheadPerMoveMs");
  assertClose(cal.penMoveMs, truePenMs, 1e-1, "penMoveMs");
});

test("deriveCalibration clamps a nonsense motion fit back to 1", () => {
  // A single stalled row would fit an absurd scaler; the clamp rejects it.
  const rows = [{ group: "motion", rawMotionSeconds: 1, moveCount: 1, penLifts: 0, actualSeconds: 999 }];
  const cal = deriveCalibration(rows, DEFAULT_CONFIG);
  assert.strictEqual(cal.motionScaler, 1, "clamped to identity");
});

// ── calibration programs are well-formed and self-contained ──
test("buildCalibrationTests emits the five action types within the box", () => {
  const tests = buildCalibrationTests({ feed: 1500, box: 80, repeats: 2 });
  assert.strictEqual(tests.length, 5, "five action types");
  assert(tests.some((t) => t.group === "pen"), "has a pen-isolation test");
  for (const test of tests) {
    assert(test.lines[test.lines.length - 1] === "M18", `${test.key} disables motors at end`);
  }
});

(async () => {
  // ── timeProgram measures elapsed wall-clock via the injected clock ──
  await testAsync("timeProgram returns elapsed seconds from the injected clock", async () => {
    let clock = 1000;
    const fakeConnection = {
      sendLine: async () => "ok",
      waitIdle: async () => { clock += 4200; }, // 4.2 s of motion after buffering
    };
    const io = { log: () => {} };
    const elapsed = await timeProgram(fakeConnection, ["G1 X10", "G1 X0"], io, () => clock);
    assertClose(elapsed, 4.2, 1e-9, "elapsed seconds");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
