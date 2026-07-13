// SVG <path d="..."> parser + curve flattener.
//
// Emits one polyline per subpath, in SVG user units (Y still pointing down —
// the caller applies transforms and the plotter-frame flip). Curves are
// flattened with recursive midpoint subdivision against a chord-error
// tolerance so long gentle curves stay light while tight ones stay smooth.

import { Point, Polyline, distance } from "./types";

/** Curve-flattening chord tolerance in user units (~mm for plotter SVGs). */
export const CURVE_TOLERANCE = 0.1;
const MAX_SUBDIVISION_DEPTH = 24;

/** Tokenize path data into commands: letters + the numbers that follow. */
function tokenize(data: string): { command: string; values: number[] }[] {
  const tokens: { command: string; values: number[] }[] = [];
  // Split on command letters; SVG allows numbers to run together with signs
  // ("1-2" = 1, -2) and flags to be undelimited only in arcs (handled below).
  const commandRegex = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let match: RegExpExecArray | null;
  while ((match = commandRegex.exec(data)) !== null) {
    const command = match[1];
    const values = parseNumberList(match[2], /[Aa]/.test(command));
    tokens.push({ command, values });
  }
  return tokens;
}

/**
 * Parse a run of numbers. Arc commands need special handling: the two flag
 * parameters are single 0/1 digits that may be glued to the next number
 * ("a25 25 0 011 0" — flags are "0","1","1"). We re-split per 7-value group.
 */
function parseNumberList(text: string, isArc: boolean): number[] {
  if (!isArc) {
    const matches = text.match(/-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/g);
    return matches ? matches.map(Number) : [];
  }
  const values: number[] = [];
  let cursor = 0;
  const numberRegex = /-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/y;
  const flagRegex = /[01]/y;
  const skipSeparators = () => {
    while (cursor < text.length && /[\s,]/.test(text[cursor])) cursor++;
  };
  while (cursor < text.length) {
    // Positions 3 and 4 of each 7-value arc group are single-digit flags.
    const positionInGroup = values.length % 7;
    const regex = positionInGroup === 3 || positionInGroup === 4 ? flagRegex : numberRegex;
    skipSeparators();
    if (cursor >= text.length) break;
    regex.lastIndex = cursor;
    const match = regex.exec(text);
    if (!match) break; // malformed tail — stop rather than loop forever
    values.push(Number(match[0]));
    cursor = regex.lastIndex;
  }
  return values;
}

/** Recursively flatten a cubic bezier onto `out` (excluding the start point). */
function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, tolerance: number, out: Polyline, depth = 0): void {
  // Flat enough when both control points sit within tolerance of the chord.
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const d1 = Math.abs((p1.x - p3.x) * dy - (p1.y - p3.y) * dx);
  const d2 = Math.abs((p2.x - p3.x) * dy - (p2.y - p3.y) * dx);
  const chordSq = dx * dx + dy * dy;
  if (depth >= MAX_SUBDIVISION_DEPTH || (d1 + d2) * (d1 + d2) <= 16 * tolerance * tolerance * chordSq || chordSq < 1e-12) {
    out.push({ x: p3.x, y: p3.y });
    return;
  }
  // de Casteljau midpoint split
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
  const p012 = mid(p01, p12), p123 = mid(p12, p23);
  const center = mid(p012, p123);
  flattenCubic(p0, p01, p012, center, tolerance, out, depth + 1);
  flattenCubic(center, p123, p23, p3, tolerance, out, depth + 1);
}

/** Flatten a quadratic bezier by promoting it to the equivalent cubic. */
function flattenQuadratic(p0: Point, control: Point, p2: Point, tolerance: number, out: Polyline): void {
  const c1 = { x: p0.x + (2 / 3) * (control.x - p0.x), y: p0.y + (2 / 3) * (control.y - p0.y) };
  const c2 = { x: p2.x + (2 / 3) * (control.x - p2.x), y: p2.y + (2 / 3) * (control.y - p2.y) };
  flattenCubic(p0, c1, c2, p2, tolerance, out);
}

/**
 * Flatten an SVG elliptical arc (endpoint parameterisation, W3C appendix
 * B.2.4 conversion to centre form) into line segments appended to `out`.
 */
function flattenArc(
  start: Point, radiusX: number, radiusY: number, rotationDeg: number,
  largeArc: boolean, sweep: boolean, end: Point, tolerance: number, out: Polyline
): void {
  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  if (rx < 1e-9 || ry < 1e-9 || (start.x === end.x && start.y === end.y)) {
    out.push({ ...end });
    return;
  }
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const halfDx = (start.x - end.x) / 2, halfDy = (start.y - end.y) / 2;
  const x1p = cosPhi * halfDx + sinPhi * halfDy;
  const y1p = -sinPhi * halfDx + cosPhi * halfDy;
  // Scale radii up if they can't span the endpoints (spec-mandated fixup).
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = sign * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;
  const centerX = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2;
  const centerY = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2;

  const angleOf = (vx: number, vy: number) => Math.atan2(vy, vx);
  const thetaStart = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry);
  const thetaEnd = angleOf((-x1p - cxp) / rx, (-y1p - cyp) / ry);
  let sweepAngle = thetaEnd - thetaStart;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;

  // Segment count from chord error on the larger radius (same formula the
  // firmware arc splitter uses): halfChord = sqrt(2*tol/r).
  const majorRadius = Math.max(rx, ry);
  const stepAngle = 2 * Math.sqrt((2 * tolerance) / majorRadius);
  const segments = Math.max(1, Math.min(4096, Math.ceil(Math.abs(sweepAngle) / stepAngle)));
  for (let segment = 1; segment <= segments; segment++) {
    if (segment === segments) {
      out.push({ ...end }); // land exactly on the endpoint, no drift
      break;
    }
    const theta = thetaStart + (sweepAngle * segment) / segments;
    const ellipseX = rx * Math.cos(theta), ellipseY = ry * Math.sin(theta);
    out.push({
      x: cosPhi * ellipseX - sinPhi * ellipseY + centerX,
      y: sinPhi * ellipseX + cosPhi * ellipseY + centerY,
    });
  }
}

/**
 * Parse path data into polylines (one per pen-down subpath), in user units.
 *
 * @param data The `d` attribute text.
 * @param tolerance Curve-flattening chord tolerance in user units.
 */
export function parsePathData(data: string, tolerance: number = CURVE_TOLERANCE): Polyline[] {
  const state = {
    polylines: [] as Polyline[],
    current: [] as Polyline,
    position: { x: 0, y: 0 } as Point,
    subpathStart: { x: 0, y: 0 } as Point,
    lastCubicControl: null as Point | null,
    lastQuadControl: null as Point | null,
  };

  const finishSubpath = () => {
    if (state.current.length > 1) state.polylines.push(state.current);
    state.current = [];
  };

  for (const { command, values } of tokenize(data)) {
    runPathCommand(command, values, state, tolerance, finishSubpath);
  }
  finishSubpath();
  return state.polylines;
}

interface PathState {
  polylines: Polyline[];
  current: Polyline;
  position: Point;
  subpathStart: Point;
  lastCubicControl: Point | null;
  lastQuadControl: Point | null;
}

/** Execute one command token (with implicit repeats) against the path state. */
function runPathCommand(
  command: string, values: number[], state: PathState, tolerance: number, finishSubpath: () => void
): void {
  const relative = command === command.toLowerCase();
  const upper = command.toUpperCase();
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const groupSize = arity[upper];
  let index = 0;
  let repeat = 0;

  do {
    const group = values.slice(index, index + groupSize);
    if (groupSize > 0 && group.length < groupSize) break;
    // After an initial M, extra coordinate pairs are implicit LINETOs.
    const effective = upper === "M" && repeat > 0 ? "L" : upper;
    applyCommandGroup(effective, relative, group, state, tolerance, finishSubpath);
    // Smooth commands (S/T) reflect the PREVIOUS control point; any other
    // command breaks that chain per the SVG spec.
    if (!["C", "S"].includes(effective)) state.lastCubicControl = null;
    if (!["Q", "T"].includes(effective)) state.lastQuadControl = null;
    index += groupSize;
    repeat++;
  } while (index < values.length && groupSize > 0);

  if (upper === "Z") {
    // Close: draw back to the subpath start, keep drawing from there.
    state.current.push({ ...state.subpathStart });
    state.position = { ...state.subpathStart };
    state.lastCubicControl = null;
    state.lastQuadControl = null;
  }
}

/** Apply a single fully-populated command group. */
function applyCommandGroup(
  command: string, relative: boolean, group: number[], state: PathState,
  tolerance: number, finishSubpath: () => void
): void {
  const pos = state.position;
  const abs = (x: number, y: number): Point => (relative ? { x: pos.x + x, y: pos.y + y } : { x, y });

  switch (command) {
    case "M": {
      finishSubpath();
      const target = abs(group[0], group[1]);
      state.position = target;
      state.subpathStart = { ...target };
      state.current = [{ ...target }];
      break;
    }
    case "L": {
      const target = abs(group[0], group[1]);
      state.current.push({ ...target });
      state.position = target;
      break;
    }
    case "H": {
      const target = relative ? { x: pos.x + group[0], y: pos.y } : { x: group[0], y: pos.y };
      state.current.push({ ...target });
      state.position = target;
      break;
    }
    case "V": {
      const target = relative ? { x: pos.x, y: pos.y + group[0] } : { x: pos.x, y: group[0] };
      state.current.push({ ...target });
      state.position = target;
      break;
    }
    case "C": {
      const c1 = abs(group[0], group[1]), c2 = abs(group[2], group[3]), end = abs(group[4], group[5]);
      flattenCubic(pos, c1, c2, end, tolerance, state.current);
      state.lastCubicControl = c2;
      state.position = end;
      break;
    }
    case "S": {
      // Reflect the previous cubic control point (or use current position).
      const c1 = state.lastCubicControl
        ? { x: 2 * pos.x - state.lastCubicControl.x, y: 2 * pos.y - state.lastCubicControl.y }
        : { ...pos };
      const c2 = abs(group[0], group[1]), end = abs(group[2], group[3]);
      flattenCubic(pos, c1, c2, end, tolerance, state.current);
      state.lastCubicControl = c2;
      state.position = end;
      break;
    }
    case "Q": {
      const control = abs(group[0], group[1]), end = abs(group[2], group[3]);
      flattenQuadratic(pos, control, end, tolerance, state.current);
      state.lastQuadControl = control;
      state.position = end;
      break;
    }
    case "T": {
      const control = state.lastQuadControl
        ? { x: 2 * pos.x - state.lastQuadControl.x, y: 2 * pos.y - state.lastQuadControl.y }
        : { ...pos };
      const end = abs(group[0], group[1]);
      flattenQuadratic(pos, control, end, tolerance, state.current);
      state.lastQuadControl = control;
      state.position = end;
      break;
    }
    case "A": {
      const end = abs(group[5], group[6]);
      flattenArc(pos, group[0], group[1], group[2], group[3] !== 0, group[4] !== 0, end, tolerance, state.current);
      state.position = end;
      break;
    }
  }
}

export { flattenCubic, flattenQuadratic, flattenArc };

/** Rough sanity check used by callers to skip empty path elements. */
export function hasDrawableLength(polylines: Polyline[]): boolean {
  return polylines.some((line) => line.length > 1 && distance(line[0], line[line.length - 1]) > 0 || line.length > 2);
}
