#!/usr/bin/env node
"use strict";
// `pnpm eta <file.gcode>` — estimate how long a G-code program will take to
// plot, using the board's own motion config.
//
// By default it reads the live settings off the plotter over serial (`$$`) so
// the estimate reflects however you've tuned $110/$120/etc. If the board isn't
// connected, pass --offline to fall back to the firmware compile-time defaults.
//
// Usage:
//   pnpm eta drawing.gcode                 # read live config from the board
//   pnpm eta drawing.gcode --offline       # use firmware defaults, no serial
//   pnpm eta drawing.gcode --port /dev/... # explicit serial port
//   pnpm eta drawing.gcode --pen-ms 150    # override the per-lift servo dwell
//   pnpm eta drawing.gcode --scaler 1.1    # override motion-time scaler
//   pnpm eta drawing.gcode --overhead-ms 8 # override per-move overhead
//   pnpm eta drawing.gcode --no-calibration# ignore saved eta-calibration.json
//
// A saved calibration (from `pnpm calibrate --save`) is applied automatically;
// the CLI flags above override individual knobs on top of it.

const fs = require("fs");
const { resolvePort, open, parseArgs } = require("./lib/serial");
const { parseGcode } = require("./lib/gcode-parser");
const { estimateEta, configFromSettings } = require("./lib/eta-engine");
const { loadCalibration } = require("./lib/calibration-store");

/** Format a duration in seconds as "H:MM:SS" (or "M:SS" under an hour). */
function formatDuration(totalSeconds) {
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Fetch live motion config from the board over serial, or return null if the
 * board can't be reached (so the caller can fall back to defaults).
 */
async function readLiveConfig(preferredPort, overrides) {
  try {
    const port = await resolvePort(preferredPort);
    const connection = await open(port);
    try {
      const settings = await connection.settings();
      if (Object.keys(settings).length === 0) return null;
      return { config: configFromSettings(settings, overrides), port };
    } finally {
      await connection.close();
    }
  } catch (error) {
    return null;
  }
}

/**
 * Resolve the calibration knobs: start from the saved eta-calibration.json (if
 * present and not disabled), then let explicit CLI flags override each knob.
 * Returns both the overrides object and a human note about their source.
 */
function resolveCalibration(args) {
  const saved = args["no-calibration"] ? null : loadCalibration();
  const overrides = { ...(saved || {}) };
  if (args["pen-ms"] !== undefined) overrides.penMoveMs = parseFloat(args["pen-ms"]);
  if (args.scaler !== undefined) overrides.motionScaler = parseFloat(args.scaler);
  if (args["overhead-ms"] !== undefined) overrides.overheadPerMoveMs = parseFloat(args["overhead-ms"]);
  const parts = [];
  if (saved) parts.push("saved eta-calibration.json");
  if (args["pen-ms"] !== undefined) parts.push(`pen-ms=${overrides.penMoveMs}`);
  if (args.scaler !== undefined) parts.push(`scaler=${overrides.motionScaler}`);
  if (args["overhead-ms"] !== undefined) parts.push(`overhead-ms=${overrides.overheadPerMoveMs}`);
  return { overrides, note: parts.length ? parts.join(", ") : "none (raw physics estimate)" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args._[0];
  if (!filePath) {
    console.error("Usage: pnpm eta <file.gcode> [--offline] [--port <path>] [--pen-ms <ms>] [--scaler <x>] [--overhead-ms <ms>] [--no-calibration]");
    process.exit(1);
  }

  let gcodeText;
  try {
    gcodeText = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.error(`Could not read G-code file "${filePath}": ${error.message}`);
    process.exit(1);
  }

  const { overrides, note: calibrationNote } = resolveCalibration(args);

  let config = configFromSettings(null, overrides); // firmware defaults
  let source = "firmware defaults (offline)";
  if (!args.offline) {
    const live = await readLiveConfig(args.port, overrides);
    if (live) {
      config = live.config;
      source = `live config from ${live.port}`;
    } else {
      source = "firmware defaults (board not reachable — use --offline to silence this)";
    }
  }

  const primitives = parseGcode(gcodeText, config.arcToleranceMm);
  const result = estimateEta(primitives, config);
  printReport(filePath, source, calibrationNote, config, result);
}

/** Print the ETA and the breakdown that produced it. */
function printReport(filePath, source, calibrationNote, config, result) {
  console.log(`\nETA for ${filePath}`);
  console.log(`  config source : ${source}`);
  console.log(`  calibration   : ${calibrationNote}`);
  console.log(`  feed/rapid cap: ${config.maxFeedrateMmMin} / ${config.maxRapidMmMin} mm/min`);
  console.log(`  accel cap     : ${config.maxAccelMmS2} mm/s²  (motor ${config.motorMaxAccelMmS2})`);
  if (config.motionScaler !== 1 || config.overheadPerMoveMs !== 0) {
    console.log(`  knobs         : motionScaler ${config.motionScaler}, overhead ${config.overheadPerMoveMs} ms/move, pen ${config.penMoveMs} ms`);
  }
  console.log("");
  console.log(`  segments      : ${result.moveCount}  (draw ${result.drawDistanceMm.toFixed(0)} mm, travel ${result.travelDistanceMm.toFixed(0)} mm)`);
  console.log(`  pen lifts     : ${result.penLifts}  (+${(result.penLifts * config.penMoveMs) / 1000}s dwell)`);
  console.log(`  motion time   : ${formatDuration(result.calibratedMotionSeconds)}${config.motionScaler !== 1 ? ` (raw ${formatDuration(result.motionSeconds)} × ${config.motionScaler})` : ""}`);
  console.log(`  move overhead : ${formatDuration(result.overheadSeconds)}`);
  console.log(`  fixed dwells  : ${formatDuration(result.fixedSeconds)}`);
  console.log(`\n  ESTIMATED ETA : ${formatDuration(result.seconds)}  (${result.seconds.toFixed(0)}s)\n`);
}

main().catch((error) => {
  console.error(`eta: ${error.message}`);
  process.exit(1);
});
