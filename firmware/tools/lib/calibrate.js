"use strict";
// ETA calibration harness (transport-agnostic, like tune-engine.js).
//
// The physics model in eta-engine.js is a good first approximation, but real
// wall-clock time drifts from it for reasons the model doesn't capture: serial
// ok/error round-trips per line, planner buffer starvation on dense paths, and
// servo settle time that may not be exactly DEFAULT_PEN_MOVE_MS. This module
// measures that drift.
//
// It runs a handful of DISTINCT action types — each stressing a different part
// of the model — estimates each with the live `$$` config, times the real run,
// and least-squares-fits three correction knobs the estimator consumes:
//   * motionScaler       — systematic speed bias (from the smooth motion tests)
//   * overheadPerMoveMs  — per-segment cost (isolated by the many-short-move test)
//   * penMoveMs          — real per-lift servo dwell (isolated by the pen test)
//
// Driven through an `io` object (log/result/summary) so both the CLI and the
// browser tuner can render progress the same way.

const { parseGcode } = require("./gcode-parser");
const { estimateEta, configFromSettings } = require("./eta-engine");

// Each test returns a group tag so deriveCalibration knows what it isolates:
//   "motion" — pen-up travel; contributes to motionScaler + overheadPerMoveMs.
//   "pen"    — repeated servo lifts with negligible travel; isolates penMoveMs.
// Motion tests keep the pen UP (no ink, no dwell) so they measure pure travel.

/**
 * Build the calibration programs sized to fit the work area and run at the
 * board's stored feed. Pure geometry — no serial.
 *
 * @param {object} params { feed (mm/min), box (mm span), repeats }
 * @returns {object[]} Tests: { key, label, group, lines: string[] }
 */
function buildCalibrationTests({ feed, box, repeats }) {
  const span = box.toFixed(2);
  const half = (box / 2).toFixed(2);
  const preamble = ["G21 G90", "M17", "G92 X0 Y0", "M5"]; // pen up for motion tests
  const postamble = ["G0 X0 Y0", "M18"];
  const feedWord = `G1 F${Math.round(feed)}`;

  const backAndForth = (tipX, tipY) => {
    const strokes = [];
    for (let pass = 0; pass < repeats; pass++) {
      strokes.push(`G1 X${tipX} Y${tipY}`, "G1 X0 Y0");
    }
    return strokes;
  };

  return [
    {
      key: "line-x",
      label: "Straight X line (pure axis, load 1)",
      group: "motion",
      lines: [...preamble, feedWord, ...backAndForth(span, "0"), ...postamble],
    },
    {
      key: "line-diag",
      label: "Diagonal line (45°, motor-rate limited)",
      group: "motion",
      lines: [...preamble, feedWord, ...backAndForth(span, span), ...postamble],
    },
    {
      key: "zigzag",
      label: "Many short segments (per-move overhead)",
      group: "motion",
      lines: [...preamble, feedWord, ...zigzagStrokes(box), ...postamble],
    },
    {
      // Full circle centred at (half, half) with radius `half`, so it spans
      // [0, box] on both axes — entirely inside the +X/+Y travel, never
      // crossing the origin into the frame.
      key: "circle",
      label: "Circle (arc segmenting + corners)",
      group: "motion",
      lines: [...preamble, feedWord, `G0 X${half} Y0`, `G2 X${half} Y0 I0 J${half} F${Math.round(feed)}`, ...postamble],
    },
    {
      key: "pen",
      label: "Pen-lift cycles (servo dwell)",
      group: "pen",
      lines: ["G21 G90", "M17", ...penCycles(10), "M18"],
    },
  ];
}

/** A dense zigzag of ~3 mm segments spanning the box — stresses per-move cost. */
function zigzagStrokes(box) {
  const segmentLength = 3;
  const count = Math.max(10, Math.floor(box / segmentLength));
  const strokes = [];
  for (let index = 1; index <= count; index++) {
    const x = (index * segmentLength).toFixed(2);
    const y = (index % 2 === 0 ? 0 : segmentLength).toFixed(2);
    strokes.push(`G1 X${x} Y${y}`);
  }
  return strokes;
}

/** N pen down/up cycles at the origin — negligible travel, all servo dwell. */
function penCycles(count) {
  const lines = [];
  for (let index = 0; index < count; index++) lines.push("M3", "M5");
  return lines;
}

/**
 * Wall-clock-time streaming a program to the board, first send → Idle. Includes
 * the serial ok handshakes and post-buffer motion — i.e. exactly what a user
 * experiences streaming a file, which is what we're calibrating against.
 *
 * @param {object} connection A lib/serial.js Connection (sendLine + waitIdle).
 * @param {string[]} lines The G-code program.
 * @param {object} io Progress sink (io.log).
 * @param {() => number} now Monotonic clock in ms (injectable for tests).
 * @returns {Promise<number>} Elapsed seconds.
 */
async function timeProgram(connection, lines, io, now) {
  const start = now();
  for (const line of lines) {
    const reply = await connection.sendLine(line, 15000);
    if (reply.startsWith("error")) io.log(`  ! [${line}] → ${reply}`);
  }
  await connection.waitIdle();
  return (now() - start) / 1000;
}

/**
 * Solve y = a·x1 + b·x2 (no intercept) by least squares. Returns null if the
 * normal-equation matrix is singular (e.g. fewer than two independent rows).
 */
function leastSquares2(samples) {
  let s11 = 0, s12 = 0, s22 = 0, sy1 = 0, sy2 = 0;
  for (const { y, x1, x2 } of samples) {
    s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2;
    sy1 += x1 * y; sy2 += x2 * y;
  }
  const determinant = s11 * s22 - s12 * s12;
  if (Math.abs(determinant) < 1e-12) return null;
  return {
    a: (sy1 * s22 - sy2 * s12) / determinant,
    b: (s11 * sy2 - s12 * sy1) / determinant,
  };
}

/**
 * Fit the three calibration knobs from the measured rows. Falls back to
 * physics defaults for any group that couldn't be isolated, and clamps the
 * fit into a sane range so a bad run can't produce absurd corrections.
 */
function deriveCalibration(rows, config) {
  const round = (value, digits) => Number(value.toFixed(digits));

  // penMoveMs: mean per-lift excess over the tiny travel in the pen test.
  let penMoveMs = config.penMoveMs;
  const perLift = rows
    .filter((row) => row.group === "pen" && row.penLifts > 0)
    .map((row) => ((row.actualSeconds - row.rawMotionSeconds) / row.penLifts) * 1000)
    .filter((value) => value > 0 && value < 2000);
  if (perLift.length) penMoveMs = perLift.reduce((a, b) => a + b, 0) / perLift.length;

  // motionScaler + overheadPerMoveMs: fit (actual − pen dwell) ≈
  // a·rawMotion + b·moveCount across the motion tests. The motion tests carry
  // one M5 (pen-up) in their preamble, so subtract its dwell — measured above —
  // before fitting, otherwise it leaks into the motion/overhead knobs.
  const penDwell = (row) => (row.penLifts * penMoveMs) / 1000;
  let motionScaler = 1;
  let overheadPerMoveMs = 0;
  const motionRows = rows.filter((row) => row.group === "motion");
  const fit = motionRows.length >= 2
    ? leastSquares2(motionRows.map((row) => ({ y: row.actualSeconds - penDwell(row), x1: row.rawMotionSeconds, x2: row.moveCount })))
    : null;
  if (fit) {
    motionScaler = fit.a;
    overheadPerMoveMs = fit.b * 1000;
  } else if (motionRows.length === 1 && motionRows[0].rawMotionSeconds > 0) {
    motionScaler = (motionRows[0].actualSeconds - penDwell(motionRows[0])) / motionRows[0].rawMotionSeconds;
  }

  // Clamp: reject nonsense fits (e.g. a stall inflating one row) rather than
  // baking them into every future estimate.
  if (!(motionScaler > 0.2 && motionScaler < 5)) motionScaler = 1;
  overheadPerMoveMs = Math.min(Math.max(overheadPerMoveMs, 0), 500);

  return {
    motionScaler: round(motionScaler, 4),
    overheadPerMoveMs: round(overheadPerMoveMs, 3),
    penMoveMs: round(penMoveMs, 1),
  };
}

/**
 * Run the full calibration on a connected board.
 *
 * @param {object} connection lib/serial.js Connection.
 * @param {object} options { io, repeats, now }
 * @returns {Promise<{rows: object[], calibration: object, config: object}>}
 */
async function runCalibration(connection, { io, repeats = 3, now = Date.now } = {}) {
  const settings = await connection.settings();
  const config = configFromSettings(settings); // physics baseline (identity knobs)
  const feed = settings["$110"] > 0 ? settings["$110"] : config.maxFeedrateMmMin;
  const maxX = settings["$130"] > 0 ? settings["$130"] : 125;
  const maxY = settings["$131"] > 0 ? settings["$131"] : 125;
  const box = Math.max(20, Math.min(80, maxX - 10, maxY - 10));
  io.log(`Calibrating at stored feed $110=${Math.round(feed)} mm/min, box ${box.toFixed(0)} mm.`);

  const tests = buildCalibrationTests({ feed, box, repeats });
  const rows = [];
  for (const test of tests) {
    const estimate = estimateEta(parseGcode(test.lines.join("\n"), config.arcToleranceMm), config);
    io.log(`\n${test.label}\n  estimate ${estimate.seconds.toFixed(1)}s (${estimate.moveCount} moves) — running…`);
    const actualSeconds = await timeProgram(connection, test.lines, io, now);
    const row = {
      key: test.key,
      label: test.label,
      group: test.group,
      estSeconds: estimate.seconds,
      rawMotionSeconds: estimate.motionSeconds,
      fixedSeconds: estimate.fixedSeconds,
      moveCount: estimate.moveCount,
      penLifts: estimate.penLifts,
      actualSeconds,
      ratio: estimate.seconds > 0 ? actualSeconds / estimate.seconds : 0,
    };
    rows.push(row);
    io.result(row);
  }

  const calibration = deriveCalibration(rows, config);
  io.summary(rows, calibration);
  return { rows, calibration, config };
}

module.exports = {
  runCalibration,
  buildCalibrationTests,
  deriveCalibration,
  leastSquares2,
  timeProgram,
};
