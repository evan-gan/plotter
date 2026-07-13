// G-code → Drawing (pen-down polylines), the geometric half of the
// GCODE → SVG converter.
//
// This intentionally mirrors the modal-state handling of the firmware and of
// firmware/tools/lib/gcode-parser.js (units G20/G21, distance G90/G91, work
// offset G92, modal motion mode, arc flattening with the same chord formula
// as arc.cpp) — but unlike that parser, which only needs *timing*, this one
// tracks pen state (M3 = down, M5 = up) so it can reconstruct geometry.

import { Drawing, Point, Polyline, boundingBox } from "./types";
import { dedupeConsecutive } from "./svg-parse";

const MM_PER_INCH = 25.4;
// Keep in sync with ARC_MIN_SEGMENT_MM in firmware/arc.cpp.
const ARC_MIN_SEGMENT_MM = 0.5;
const DEFAULT_ARC_TOLERANCE_MM = 0.01;

function wordValue(line: string, letter: string): number | null {
  const match = line.match(new RegExp(letter + "\\s*(-?\\d*\\.?\\d+)", "i"));
  return match ? parseFloat(match[1]) : null;
}

function stripComments(line: string): string {
  return line.replace(/\(.*?\)/g, "").replace(/;.*$/, "").trim();
}

/** Flatten a G2/G3 arc into points appended to `out` (arc.cpp's chord math). */
function flattenGcodeArc(
  start: Point, end: Point, offsetI: number, offsetJ: number,
  clockwise: boolean, arcToleranceMm: number, out: Point[]
): void {
  const centerX = start.x + offsetI;
  const centerY = start.y + offsetJ;
  const radius = Math.hypot(offsetI, offsetJ);
  if (radius < 1e-5) return;

  const thetaStart = Math.atan2(-offsetJ, -offsetI);
  const thetaEnd = Math.atan2(end.y - centerY, end.x - centerX);
  let sweep = thetaEnd - thetaStart;
  if (clockwise && sweep >= 0) sweep -= 2 * Math.PI;
  if (!clockwise && sweep <= 0) sweep += 2 * Math.PI;
  if (Math.abs(sweep) < 1e-6) sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;

  const halfChord = Math.sqrt((2 * Math.max(arcToleranceMm, 1e-4)) / radius);
  let segments = Math.ceil(Math.abs(sweep) / (2 * halfChord));
  segments = Math.min(segments, Math.ceil((Math.abs(sweep) * radius) / ARC_MIN_SEGMENT_MM));
  segments = Math.max(1, Math.min(4096, segments));

  for (let segment = 1; segment <= segments; segment++) {
    if (segment === segments) {
      out.push({ ...end });
    } else {
      const theta = thetaStart + (sweep * segment) / segments;
      out.push({ x: centerX + radius * Math.cos(theta), y: centerY + radius * Math.sin(theta) });
    }
  }
}

/**
 * Parse G-code text into the pen-down geometry it draws.
 *
 * @param gcodeText The program source.
 * @param arcToleranceMm Chord tolerance for flattening G2/G3.
 * @returns Drawing whose polylines are the pen-down strokes, in mm.
 */
export function gcodeToDrawing(gcodeText: string, arcToleranceMm: number = DEFAULT_ARC_TOLERANCE_MM): Drawing {
  const polylines: Polyline[] = [];
  let current: Polyline = [];
  const position: Point = { x: 0, y: 0 };
  const offset: Point = { x: 0, y: 0 };
  let unitScale = 1;
  let absolute = true;
  let motionMode = 0;
  let penDown = false;

  const endStroke = () => {
    if (current.length >= 2) polylines.push(current);
    current = [];
  };

  for (const rawLine of gcodeText.split(/\r?\n/)) {
    const line = stripComments(rawLine);
    if (!line) continue;

    if (/\bG20\b/i.test(line)) unitScale = MM_PER_INCH;
    if (/\bG21\b/i.test(line)) unitScale = 1;
    if (/\bG90\b/i.test(line)) absolute = true;
    if (/\bG91\b/i.test(line)) absolute = false;
    if (/\bM0?3\b/i.test(line) && !penDown) {
      penDown = true;
      current = [{ ...position }];
    }
    if (/\bM0?5\b/i.test(line)) {
      penDown = false;
      endStroke();
    }

    const motionWord = line.match(/\bG0*([0123])\b/i);
    if (motionWord) motionMode = parseInt(motionWord[1], 10);

    if (/\bG92\b/i.test(line)) {
      const xWord = wordValue(line, "X");
      const yWord = wordValue(line, "Y");
      if (xWord !== null) offset.x = position.x - xWord * unitScale;
      if (yWord !== null) offset.y = position.y - yWord * unitScale;
      continue;
    }
    if (wordValue(line, "X") === null && wordValue(line, "Y") === null) continue;

    const target = resolveTarget(line, position, offset, unitScale, absolute);
    if (penDown && (motionMode === 2 || motionMode === 3)) {
      flattenGcodeArc(
        position, target,
        (wordValue(line, "I") || 0) * unitScale, (wordValue(line, "J") || 0) * unitScale,
        motionMode === 2, arcToleranceMm, current
      );
    } else if (penDown) {
      // Includes G0 rapids: with the pen down a rapid still marks the paper,
      // so the preview shows what the paper will show.
      current.push({ ...target });
    }
    position.x = target.x;
    position.y = target.y;
  }
  endStroke();

  const cleaned = polylines.map((line) => dedupeConsecutive(line)).filter((line) => line.length >= 2);
  const box = boundingBox(cleaned);
  return { polylines: cleaned, widthMm: box.maxX - box.minX, heightMm: box.maxY - box.minY };
}

function resolveTarget(line: string, position: Point, offset: Point, unitScale: number, absolute: boolean): Point {
  const xWord = wordValue(line, "X");
  const yWord = wordValue(line, "Y");
  let x = position.x;
  let y = position.y;
  if (xWord !== null) x = absolute ? xWord * unitScale + offset.x : position.x + xWord * unitScale;
  if (yWord !== null) y = absolute ? yWord * unitScale + offset.y : position.y + yWord * unitScale;
  return { x, y };
}
