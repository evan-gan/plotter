// Crossing-breakpoint pre-stage for the path optimizer.
//
// Before the optimizer chains/orders polylines it can only join paths at their
// existing endpoints, so two strokes that physically *cross* stay two atomic
// segments. This stage splits every polyline at each point where it crosses
// another polyline (or itself), inserting the crossing as a new vertex and
// cutting the polyline there. Each crossing then becomes a shared endpoint of
// the resulting sub-polylines, so the downstream merge→chain→tour can route the
// pen straight through it — turning many crossing strokes into fewer continuous
// pen-down runs.
//
// The drawn ink is unchanged: a split only adds a collinear vertex the pen was
// already going to pass through. Coordinates are millimetres (see types.ts).

import { Point, Polyline } from "./types";

/** A crossing found on one polyline's segment, at parameter `t` along it. */
interface SegmentSplit {
  /** Position along the segment, 0 = segment start, 1 = segment end. */
  t: number;
  point: Point;
}

/** Per-polyline accumulation of where to break it. */
interface PolylineBreaks {
  /** Original vertex indices that a crossing landed exactly on. */
  vertexBreaks: Set<number>;
  /** Interior crossings per segment index (segment k spans vertex k→k+1). */
  segmentSplits: Map<number, SegmentSplit[]>;
}

// A crossing whose parameter is within this fraction/distance of a segment end
// is treated as landing *on* the existing vertex rather than splitting the
// segment (avoids zero-length slivers). Absolute distance in mm.
const ENDPOINT_EPS_MM = 1e-6;
// Denominator threshold below which two segments are treated as parallel.
const PARALLEL_EPS = 1e-12;
// Skip splitting entirely above this segment count (perf guard); the optimizer
// falls back to its endpoint-only behaviour for pathological inputs.
const MAX_SEGMENTS = 40000;

interface SegmentRef {
  /** Index of the polyline this segment belongs to. */
  lineIndex: number;
  /** Index of the segment within that polyline (spans vertex k→k+1). */
  segmentIndex: number;
  start: Point;
  end: Point;
}

/**
 * Split every polyline at its crossings with other polylines and with itself,
 * so crossings become shared endpoints the optimizer can route through.
 *
 * @param polylines Input paths (already flattened to line segments).
 * @returns A new polyline set covering identical ink; unchanged polylines are
 *   returned as-is. If no crossings exist the returned set equals the input.
 */
export function splitPolylinesAtIntersections(polylines: Polyline[]): Polyline[] {
  const segments = collectSegments(polylines);
  if (segments.length < 2 || segments.length > MAX_SEGMENTS) return polylines;

  const breaks: PolylineBreaks[] = polylines.map(() => ({
    vertexBreaks: new Set<number>(),
    segmentSplits: new Map<number, SegmentSplit[]>(),
  }));

  findCrossings(segments, (refA, refB, tA, tB, point) => {
    recordCrossing(breaks[refA.lineIndex], refA, tA, point);
    recordCrossing(breaks[refB.lineIndex], refB, tB, point);
  });

  const result: Polyline[] = [];
  polylines.forEach((line, lineIndex) => {
    result.push(...splitOne(line, breaks[lineIndex]));
  });
  return result;
}

/** Flatten all polylines into individually addressable segments (≥2 pts). */
function collectSegments(polylines: Polyline[]): SegmentRef[] {
  const segments: SegmentRef[] = [];
  polylines.forEach((line, lineIndex) => {
    for (let segmentIndex = 0; segmentIndex + 1 < line.length; segmentIndex++) {
      segments.push({
        lineIndex,
        segmentIndex,
        start: line[segmentIndex],
        end: line[segmentIndex + 1],
      });
    }
  });
  return segments;
}

/**
 * Record a crossing on one polyline: either as a split partway along the
 * segment or, if it lands within ENDPOINT_EPS_MM of a segment end, as a break
 * at that existing vertex (avoids zero-length slivers). Endpoint proximity is
 * judged in real distance, not parameter space, so it holds for any segment
 * length.
 */
function recordCrossing(breaks: PolylineBreaks, segment: SegmentRef, t: number, point: Point): void {
  const segmentIndex = segment.segmentIndex;
  if (distanceBetween(point, segment.start) <= ENDPOINT_EPS_MM) {
    breaks.vertexBreaks.add(segmentIndex);
  } else if (distanceBetween(point, segment.end) <= ENDPOINT_EPS_MM) {
    breaks.vertexBreaks.add(segmentIndex + 1);
  } else {
    const list = breaks.segmentSplits.get(segmentIndex);
    if (list) list.push({ t, point });
    else breaks.segmentSplits.set(segmentIndex, [{ t, point }]);
  }
}

/**
 * Rebuild one polyline with crossing vertices inserted, then cut it into
 * sub-polylines at every break vertex. Returns [line] unchanged if it has no
 * breaks. Consecutive sub-polylines share the break point (both keep a copy),
 * which the downstream endpoint merge re-clusters.
 */
function splitOne(line: Polyline, breaks: PolylineBreaks): Polyline[] {
  if (breaks.vertexBreaks.size === 0 && breaks.segmentSplits.size === 0) return [line];

  // Build the augmented vertex list, tagging which vertices are cut points.
  const points: Point[] = [];
  const isBreak: boolean[] = [];
  const pushPoint = (point: Point, breakHere: boolean) => {
    points.push(point);
    isBreak.push(breakHere);
  };

  pushPoint(line[0], breaks.vertexBreaks.has(0));
  for (let segmentIndex = 0; segmentIndex + 1 < line.length; segmentIndex++) {
    const splits = breaks.segmentSplits.get(segmentIndex);
    if (splits) {
      splits.sort((a, b) => a.t - b.t);
      for (const split of splits) pushPoint(split.point, true);
    }
    pushPoint(line[segmentIndex + 1], breaks.vertexBreaks.has(segmentIndex + 1));
  }

  // Cut at every break vertex; the break point ends one piece and starts the
  // next (line ends are natural boundaries and never dropped).
  const pieces: Polyline[] = [];
  let current: Point[] = [points[0]];
  for (let index = 1; index < points.length; index++) {
    current.push(points[index]);
    if (isBreak[index] && index < points.length - 1) {
      pieces.push(current);
      current = [points[index]];
    }
  }
  pieces.push(current);
  return pieces.filter((piece) => piece.length >= 2);
}

// ───────────────────────── spatial crossing search ────────────────────────

/**
 * Find all proper crossings between segments using a uniform grid to avoid the
 * O(n²) all-pairs test. Adjacent segments of the same polyline (which merely
 * share a vertex) are skipped; genuine self-crossings are kept.
 *
 * @param onCrossing Called once per crossing with both segment refs, the
 *   parameter along each segment (tA, tB ∈ [0,1]), and the crossing point.
 */
function findCrossings(
  segments: SegmentRef[],
  onCrossing: (refA: SegmentRef, refB: SegmentRef, tA: number, tB: number, point: Point) => void
): void {
  const cellSize = chooseCellSize(segments);
  const grid = new Map<string, number[]>();
  const cellKey = (cellX: number, cellY: number) => `${cellX}:${cellY}`;

  const cellsFor = (segment: SegmentRef): string[] => {
    const minX = Math.min(segment.start.x, segment.end.x);
    const maxX = Math.max(segment.start.x, segment.end.x);
    const minY = Math.min(segment.start.y, segment.end.y);
    const maxY = Math.max(segment.start.y, segment.end.y);
    const keys: string[] = [];
    for (let cellX = Math.floor(minX / cellSize); cellX <= Math.floor(maxX / cellSize); cellX++) {
      for (let cellY = Math.floor(minY / cellSize); cellY <= Math.floor(maxY / cellSize); cellY++) {
        keys.push(cellKey(cellX, cellY));
      }
    }
    return keys;
  };

  segments.forEach((segment, id) => {
    for (const key of cellsFor(segment)) {
      const bucket = grid.get(key);
      if (bucket) bucket.push(id);
      else grid.set(key, [id]);
    }
  });

  // Test each pair at most once even when they share several cells.
  const testedPairs = new Set<string>();
  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const idA = bucket[i];
        const idB = bucket[j];
        const lowId = Math.min(idA, idB);
        const highId = Math.max(idA, idB);
        const pairKey = `${lowId}:${highId}`;
        if (testedPairs.has(pairKey)) continue;
        testedPairs.add(pairKey);
        testPair(segments[lowId], segments[highId], onCrossing);
      }
    }
  }
}

/** Test one segment pair, emitting a crossing if their interiors intersect. */
function testPair(
  refA: SegmentRef,
  refB: SegmentRef,
  onCrossing: (refA: SegmentRef, refB: SegmentRef, tA: number, tB: number, point: Point) => void
): void {
  // Skip consecutive segments of the same polyline: they legitimately share a
  // vertex and would register a spurious t≈0/1 "crossing".
  if (refA.lineIndex === refB.lineIndex && Math.abs(refA.segmentIndex - refB.segmentIndex) <= 1) return;

  const crossing = segmentIntersection(refA.start, refA.end, refB.start, refB.end);
  if (crossing) onCrossing(refA, refB, crossing.tA, crossing.tB, crossing.point);
}

/**
 * Intersection of segments A(p1→p2) and B(p3→p4). Returns the crossing point
 * with its parameter along each segment, or null if parallel or non-crossing.
 * Endpoints count as crossings (tA/tB may be 0 or 1); the caller decides
 * whether that warrants a split.
 */
export function segmentIntersection(
  p1: Point, p2: Point, p3: Point, p4: Point
): { tA: number; tB: number; point: Point } | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = p4.x - p3.x;
  const sy = p4.y - p3.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < PARALLEL_EPS) return null; // parallel or collinear

  const originDeltaX = p3.x - p1.x;
  const originDeltaY = p3.y - p1.y;
  const tA = (originDeltaX * sy - originDeltaY * sx) / denom;
  const tB = (originDeltaX * ry - originDeltaY * rx) / denom;
  if (tA < 0 || tA > 1 || tB < 0 || tB > 1) return null;

  return { tA, tB, point: { x: p1.x + tA * rx, y: p1.y + tA * ry } };
}

/** Grid cell size: the mean segment length, floored to stay positive. */
function chooseCellSize(segments: SegmentRef[]): number {
  let totalLength = 0;
  for (const segment of segments) totalLength += distanceBetween(segment.start, segment.end);
  const mean = totalLength / segments.length;
  return mean > ENDPOINT_EPS_MM ? mean : 1;
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
