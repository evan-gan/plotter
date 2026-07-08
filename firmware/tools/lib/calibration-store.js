"use strict";
// Load/save the ETA calibration knobs derived by `pnpm calibrate`. Kept in a
// single JSON file next to the tools so both eta.js and the browser tuner read
// the same values. The file holds only the three correction knobs plus a note
// of when/how it was made — never the raw `$$` settings, which are always read
// live from the board.

const fs = require("fs");
const path = require("path");

const CALIBRATION_FILE = path.join(__dirname, "..", "eta-calibration.json");

/**
 * Read the saved calibration, or null if none exists / it's unreadable.
 * @returns {{motionScaler:number, overheadPerMoveMs:number, penMoveMs:number}|null}
 */
function loadCalibration() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CALIBRATION_FILE, "utf8"));
    if (typeof parsed.motionScaler !== "number") return null;
    return parsed;
  } catch {
    return null; // absent or corrupt — caller falls back to physics defaults
  }
}

/**
 * Persist a calibration to disk. `savedAt` is stamped by the caller (the ISO
 * time isn't generated here so the write is easy to unit-test deterministically).
 * @param {object} calibration The knobs to save.
 * @returns {string} The path written.
 */
function saveCalibration(calibration) {
  fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(calibration, null, 2) + "\n");
  return CALIBRATION_FILE;
}

module.exports = { loadCalibration, saveCalibration, CALIBRATION_FILE };
