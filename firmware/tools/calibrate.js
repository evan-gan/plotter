#!/usr/bin/env node
"use strict";
// `pnpm calibrate` — dial in the ETA estimator against real hardware.
//
// Runs a set of distinct action types (straight line, diagonal, dense zigzag,
// circle, pen-lift cycles) at the board's STORED feed/accel, times each on the
// machine, compares to the physics estimate, and least-squares-fits three
// correction knobs. Print-only by default; --save writes eta-calibration.json
// so `pnpm eta` (and the browser tuner) apply the correction automatically.
//
// The pen stays UP for the motion tests, so no ink or paper is needed — the
// head just traces the shapes in the air. Clear ~80 mm of +X/+Y travel first.
//
// Usage:
//   pnpm calibrate                 # run + print suggested scalers
//   pnpm calibrate --save          # also persist them
//   pnpm calibrate --repeats 5     # more back-and-forth passes per motion test
//   pnpm calibrate --port /dev/... # explicit serial port

const { resolvePort, open, parseArgs } = require("./lib/serial");
const { runCalibration } = require("./lib/calibrate");
const { saveCalibration, CALIBRATION_FILE } = require("./lib/calibration-store");

/** Right-pad a string to `width` for simple column output. */
function pad(text, width) {
  return String(text).padEnd(width);
}

/** Console `io` sink matching the shape lib/calibrate.js expects. */
const consoleIo = {
  log: (text) => console.log(text),
  result: (row) =>
    console.log(
      `  → est ${row.estSeconds.toFixed(1)}s  actual ${row.actualSeconds.toFixed(1)}s  ratio ${row.ratio.toFixed(2)}×`
    ),
  summary: (rows, calibration) => printSummary(rows, calibration),
};

/** Render the comparison table and the fitted knobs. */
function printSummary(rows, calibration) {
  console.log(`\n${"─".repeat(66)}`);
  console.log(`  ${pad("action", 40)}${pad("est", 8)}${pad("actual", 8)}ratio`);
  for (const row of rows) {
    console.log(
      `  ${pad(row.label, 40)}${pad(row.estSeconds.toFixed(1) + "s", 8)}${pad(row.actualSeconds.toFixed(1) + "s", 8)}${row.ratio.toFixed(2)}×`
    );
  }
  console.log(`${"─".repeat(66)}`);
  console.log("\n  Suggested calibration knobs:");
  console.log(`    motionScaler      = ${calibration.motionScaler}`);
  console.log(`    overheadPerMoveMs = ${calibration.overheadPerMoveMs}`);
  console.log(`    penMoveMs         = ${calibration.penMoveMs}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repeats = args.repeats ? Math.max(1, parseInt(args.repeats, 10)) : 3;
  const serialPath = await resolvePort(args.port);
  const connection = await open(serialPath);
  console.log(`plotter-calibrate — serial ${serialPath}`);
  console.log("Clear ~80 mm of +X/+Y travel; the pen stays up (no ink needed).\n");

  try {
    const { calibration } = await runCalibration(connection, { io: consoleIo, repeats });
    if (args.save) {
      const stamped = { ...calibration, savedAt: new Date().toISOString(), note: "pnpm calibrate --save" };
      const written = saveCalibration(stamped);
      console.log(`\nSaved to ${written} — pnpm eta now applies it automatically.`);
    } else {
      console.log(`\nRe-run with --save to write these to ${CALIBRATION_FILE}.`);
    }
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error(`calibrate: ${error.message}`);
  process.exit(1);
});
