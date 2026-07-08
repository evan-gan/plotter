"use strict";
// G-code → motion-primitive parser for the ETA estimator.
//
// Turns a text G-code program into a flat, modal-state-free list of primitives
// the timing engine can integrate:
//   { type: "move",  x, y, feedMmMin, rapid }  — a straight line to (x, y) mm
//   { type: "pen" }                            — an M3/M5 servo move (fixed dwell)
//   { type: "dwell", ms }                      — a G4 pause
//
// It resolves the modal state the firmware itself tracks (units G20/G21,
// distance mode G90/G91, work offset G92, modal feedrate F, and the modal
// motion mode) so the engine never has to. Arcs (G2/G3) are flattened into
// straight segments using the SAME chord-tolerance formula as the on-device
// arc.cpp, so the segment count — and therefore the timing — matches hardware.
//
// Positions are emitted in millimetres. Only deltas matter to the timing
// engine, so the constant G92 offset is applied consistently but its absolute
// value is irrelevant.

const MM_PER_INCH = 25.4;

// Matches arc.cpp: sub-segments are never shorter than this, which caps the
// count on tiny arcs so a tight arc tolerance can't explode into thousands of
// micro-moves. Keep in sync with ARC_MIN_SEGMENT_MM in arc.cpp.
const ARC_MIN_SEGMENT_MM = 0.5;

/**
 * Parse one G-code word letter out of a line, e.g. wordValue("G1 X10", "X") → 10.
 * Returns null when the letter isn't present. Case-insensitive on the letter.
 */
function wordValue(line, letter) {
  const match = line.match(new RegExp(letter + "\\s*(-?\\d*\\.?\\d+)", "i"));
  return match ? parseFloat(match[1]) : null;
}

/** Strip `; line comments` and `( inline comments )`, and trim whitespace. */
function stripComments(line) {
  return line.replace(/\(.*?\)/g, "").replace(/;.*$/, "").trim();
}

/**
 * Flatten a G2/G3 arc into straight segments, appending each as a "move"
 * primitive. Mirrors arc.cpp's segment-count math so the ETA matches the board.
 *
 * @param {object} start Current {x, y} position in mm (machine frame).
 * @param {number} endX Target X in mm.
 * @param {number} endY Target Y in mm.
 * @param {number} offsetI Arc centre X offset (I word) in mm.
 * @param {number} offsetJ Arc centre Y offset (J word) in mm.
 * @param {boolean} clockwise True for G2, false for G3.
 * @param {number} feedMmMin Feedrate for the arc segments.
 * @param {number} arcToleranceMm Chord-error target ($12/$141).
 * @param {object[]} out Primitive list to push segment moves onto.
 */
function flattenArc(start, endX, endY, offsetI, offsetJ, clockwise, feedMmMin, arcToleranceMm, out) {
  const centerX = start.x + offsetI;
  const centerY = start.y + offsetJ;
  const radius = Math.hypot(offsetI, offsetJ);
  if (radius < 1e-5) return; // degenerate — firmware rejects it too

  const thetaStart = Math.atan2(-offsetJ, -offsetI);
  const thetaEnd = Math.atan2(endY - centerY, endX - centerX);
  let sweep = thetaEnd - thetaStart;
  if (clockwise && sweep >= 0) sweep -= 2 * Math.PI;
  if (!clockwise && sweep <= 0) sweep += 2 * Math.PI;
  if (Math.abs(sweep) < 1e-6) sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;

  const tolerance = arcToleranceMm > 0 ? arcToleranceMm : 1e-4;
  const halfChordRad = Math.sqrt((2 * tolerance) / radius);
  let segments = Math.ceil(Math.abs(sweep) / (2 * halfChordRad));
  const byLength = Math.ceil((Math.abs(sweep) * radius) / ARC_MIN_SEGMENT_MM);
  segments = Math.min(segments, byLength);
  segments = Math.max(1, Math.min(4096, segments));

  const delta = sweep / segments;
  for (let segment = 1; segment <= segments; segment++) {
    // Last segment lands on the exact commanded target to avoid drift,
    // exactly as arc.cpp does.
    if (segment === segments) {
      out.push({ type: "move", x: endX, y: endY, feedMmMin, rapid: false });
    } else {
      const angle = thetaStart + delta * segment;
      out.push({
        type: "move",
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
        feedMmMin,
        rapid: false,
      });
    }
  }
}

/**
 * Parse a full G-code program into motion primitives.
 *
 * @param {string} text The G-code source.
 * @param {number} arcToleranceMm Arc chord tolerance for G2/G3 flattening.
 * @returns {object[]} Ordered list of move/pen/dwell primitives (mm, mm/min, ms).
 */
function parseGcode(text, arcToleranceMm) {
  const primitives = [];
  const position = { x: 0, y: 0 };
  const offset = { x: 0, y: 0 }; // G92 work offset (constant shift, mm)
  let unitScale = 1.0; // G21 mm (default) → 1, G20 inch → 25.4
  let absolute = true; // G90 default
  let feedMmMin = 0; // modal F; 0 means "use firmware max"
  let motionMode = 0; // modal G0/G1/G2/G3

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComments(rawLine);
    if (!line) continue;

    if (/\bG20\b/i.test(line)) unitScale = MM_PER_INCH;
    if (/\bG21\b/i.test(line)) unitScale = 1.0;
    if (/\bG90\b/i.test(line)) absolute = true;
    if (/\bG91\b/i.test(line)) absolute = false;

    if (/\bM3\b/i.test(line) || /\bM5\b/i.test(line)) primitives.push({ type: "pen" });

    if (/\bG4\b/i.test(line)) {
      // Firmware quirk: G4 P is milliseconds (not seconds); S is seconds.
      const pMs = wordValue(line, "P");
      const sSec = wordValue(line, "S");
      const ms = pMs !== null ? pMs : sSec !== null ? sSec * 1000 : 0;
      primitives.push({ type: "dwell", ms: Math.max(0, ms) });
    }

    const feedWord = wordValue(line, "F");
    if (feedWord !== null) feedMmMin = feedWord * unitScale;

    const motionWord = matchMotionMode(line);
    if (motionWord !== null) motionMode = motionWord;

    if (/\bG92\b/i.test(line)) {
      // Redefine work origin: shift the offset so current position maps to the
      // requested coords. No physical motion, so no primitive is emitted.
      applyG92(line, position, offset, unitScale);
      continue;
    }

    // Only lines that actually carry an axis word command motion.
    if (wordValue(line, "X") === null && wordValue(line, "Y") === null) continue;

    const target = resolveTarget(line, position, offset, unitScale, absolute);
    if (motionMode === 2 || motionMode === 3) {
      const offsetI = (wordValue(line, "I") || 0) * unitScale;
      const offsetJ = (wordValue(line, "J") || 0) * unitScale;
      flattenArc(position, target.x, target.y, offsetI, offsetJ, motionMode === 2, feedMmMin, arcToleranceMm, primitives);
    } else {
      primitives.push({ type: "move", x: target.x, y: target.y, feedMmMin, rapid: motionMode === 0 });
    }
    position.x = target.x;
    position.y = target.y;
  }
  return primitives;
}

/** Return the modal motion mode a line sets (0/1/2/3), or null if none. */
function matchMotionMode(line) {
  const match = line.match(/\bG0*([0123])\b/i);
  return match ? parseInt(match[1], 10) : null;
}

/** Resolve an X/Y target to absolute machine mm, honouring G90/G91 and G92. */
function resolveTarget(line, position, offset, unitScale, absolute) {
  const xWord = wordValue(line, "X");
  const yWord = wordValue(line, "Y");
  let x = position.x;
  let y = position.y;
  if (xWord !== null) x = absolute ? xWord * unitScale + offset.x : position.x + xWord * unitScale;
  if (yWord !== null) y = absolute ? yWord * unitScale + offset.y : position.y + yWord * unitScale;
  return { x, y };
}

/** Apply a G92 by shifting the work offset so `position` reads as the words. */
function applyG92(line, position, offset, unitScale) {
  const xWord = wordValue(line, "X");
  const yWord = wordValue(line, "Y");
  if (xWord !== null) offset.x = position.x - xWord * unitScale;
  if (yWord !== null) offset.y = position.y - yWord * unitScale;
}

module.exports = { parseGcode, flattenArc, wordValue, stripComments, ARC_MIN_SEGMENT_MM };
