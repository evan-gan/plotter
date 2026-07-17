// Photo → single-pen line-art. TypeScript port of the three vpype generators
// from upgraded-blot (`ui/photo_to_lineart.py`, `scribble_lineart.py`,
// `pintr_lineart.py`). Each turns a grayscale image into pen-down polylines the
// plotter can draw; they trade off differently between fidelity and pen travel.
//
// The image decode/resize is left to the caller (the browser does it with a
// canvas): callers pass a square luminance grid, this module does the darkness
// levels/gamma and the stroke generation, and returns a `Drawing` in mm.

import { Drawing, Point, Polyline } from "./types";
import { KdTree } from "./kd-tree";

export type LineartAlgorithm = "stipple" | "scribble" | "pintr";

export interface ImageToLineartOptions {
  algorithm?: LineartAlgorithm;
  /** Physical size of the (square) work canvas the art is scaled into. */
  canvasMm?: number;
  penWidthMm?: number;
  /** Levels + gamma shaping of the darkness map (shared by all algorithms). */
  minValue?: number; // brightness ≥ this → white (no ink)
  maxValue?: number; // brightness ≤ this → maximum darkness
  contrast?: number; // linear contrast about mid-gray (1 = identity)
  gamma?: number; // >1 emphasises darks
  /** Reproducibility: same seed + same image → same drawing. */
  seed?: number;

  // ── stipple (photo_to_lineart) ──
  density?: number; // point-count multiplier
  lloydIters?: number;
  smoothSubdiv?: number;

  // ── scribble (scribble_lineart) ──
  penBlackness?: number; // ink laid per stroke, 0–255 scale
  maxDarkness?: number; // clamp target darkness (lower = lighter output)
  maxSteps?: number;
  angleSamples?: number;
  baseSegmentPx?: number;
  maxSegmentPx?: number;

  // ── pintr (pintr_lineart) ──
  totalLines?: number;
  candidates?: number;
  penOpacity?: number;
  singleLine?: boolean;
}

interface ResolvedOptions extends Required<ImageToLineartOptions> {}

const DEFAULTS: ResolvedOptions = {
  algorithm: "stipple",
  canvasMm: 125,
  penWidthMm: 0.4,
  minValue: 0.85,
  maxValue: 0.15,
  contrast: 2.0,
  gamma: 1.4,
  seed: 0,
  density: 3.0,
  lloydIters: 20,
  smoothSubdiv: 6,
  penBlackness: 64,
  maxDarkness: 1.0,
  maxSteps: 12000,
  angleSamples: 96,
  baseSegmentPx: 3.0,
  maxSegmentPx: 48.0,
  totalLines: 4000,
  candidates: 20,
  penOpacity: 0.33,
  singleLine: true,
};

// ── seeded RNG (replaces numpy's default_rng) ──

/** Small deterministic PRNG (mulberry32) so seeded runs are reproducible. */
function makeRng(seed: number) {
  let state = (seed >>> 0) || 1;
  const nextFloat = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** float in [0, 1) */
    random: nextFloat,
    /** integer in [0, max) */
    int: (max: number): number => Math.floor(nextFloat() * max),
    /** float in [lo, hi) */
    uniform: (lo: number, hi: number): number => lo + nextFloat() * (hi - lo),
    /** standard-normal sample via Box–Muller */
    normal: (): number => {
      const u1 = Math.max(nextFloat(), 1e-12);
      const u2 = nextFloat();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}

type Rng = ReturnType<typeof makeRng>;

// ── shared preprocessing ──

/**
 * Turn a square luminance grid (0–255) into a darkness map in [0, 1] using the
 * same contrast → levels → gamma pipeline as the reference `load_darkness`.
 *
 * @param luminance Row-major grayscale values, length `size * size`.
 * @param size Side length of the square grid.
 * @returns Float32Array darkness map, same length as `luminance`.
 */
export function computeDarkness(
  luminance: Float32Array | Uint8ClampedArray,
  size: number,
  options: ImageToLineartOptions = {},
): Float32Array {
  const { contrast, minValue, maxValue, gamma } = { ...DEFAULTS, ...options };
  const span = Math.max(minValue - maxValue, 1e-6);
  const darkness = new Float32Array(luminance.length);
  for (let i = 0; i < luminance.length; i++) {
    let brightness = luminance[i] / 255;
    if (contrast !== 1) brightness = clamp((brightness - 0.5) * contrast + 0.5, 0, 1);
    const level = clamp((minValue - brightness) / span, 0, 1);
    darkness[i] = Math.pow(level, gamma);
  }
  return darkness;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

// ── public entry point ──

/**
 * Convert a darkness map into a pen-plottable `Drawing`.
 *
 * @param darkness Darkness map in [0, 1] (from `computeDarkness`), row-major.
 * @param size Side length of the square darkness grid.
 * @returns Drawing whose polylines are in mm, Y-up (ready for `drawingToSvg`).
 */
export function imageToLineart(darkness: Float32Array, size: number, options: ImageToLineartOptions = {}): Drawing {
  const resolved: ResolvedOptions = { ...DEFAULTS, ...options };
  const rng = makeRng(resolved.seed);
  let pixelPolylines: Polyline[];
  switch (resolved.algorithm) {
    case "scribble":
      pixelPolylines = scribblePaths(darkness, size, resolved, rng);
      break;
    case "pintr":
      pixelPolylines = pintrPaths(darkness, size, resolved, rng);
      break;
    default:
      pixelPolylines = stipplePaths(darkness, size, resolved, rng);
  }
  return toDrawing(pixelPolylines, size, resolved.canvasMm);
}

/**
 * Map image-pixel polylines (Y-down, origin top-left) into a mm-space Drawing
 * (Y-up), so the preview and plot come out upright.
 */
function toDrawing(pixelPolylines: Polyline[], size: number, canvasMm: number): Drawing {
  const scale = canvasMm / size;
  const polylines = pixelPolylines
    .filter((line) => line.length >= 2)
    .map((line) => line.map((point) => ({ x: point.x * scale, y: (size - point.y) * scale })));
  return { polylines, widthMm: canvasMm, heightMm: canvasMm };
}

// ── stipple / TSP / Catmull-Rom (photo_to_lineart) ──

function stipplePaths(darkness: Float32Array, size: number, options: ResolvedOptions, rng: Rng): Polyline[] {
  let meanDarkness = 0;
  for (let i = 0; i < darkness.length; i++) meanDarkness += darkness[i];
  meanDarkness /= darkness.length;

  const rawCount = options.density * options.canvasMm * options.canvasMm * meanDarkness;
  const count = Math.max(200, Math.min(Math.round(rawCount), 12000));

  let points = rejectionSample(darkness, size, count, rng);
  points = lloydRelax(points, darkness, size, options.lloydIters);
  const minSpacingPx = (options.penWidthMm * size) / options.canvasMm;
  points = dedupeClose(points, minSpacingPx);

  const order = nearestNeighborTour(points);
  const tour = order.map((index) => points[index]);
  const smoothed = catmullRom(tour, options.smoothSubdiv);
  for (const point of smoothed) {
    point.x = clamp(point.x, 0, size - 1);
    point.y = clamp(point.y, 0, size - 1);
  }

  // Lift the pen across any nearest-neighbour "long edge" instead of dragging
  // an ugly straight ink line over the artwork.
  const maxJumpPx = Math.max(3, (options.penWidthMm * 5 * size) / options.canvasMm);
  return splitLongSegments(smoothed, maxJumpPx);
}

/** Darkness-weighted rejection sampling: darker regions get more points. */
function rejectionSample(darkness: Float32Array, size: number, count: number, rng: Rng): Point[] {
  let peak = 0;
  for (let i = 0; i < darkness.length; i++) if (darkness[i] > peak) peak = darkness[i];
  if (peak === 0) peak = 1;
  const points: Point[] = [];
  while (points.length < count) {
    const px = rng.int(size);
    const py = rng.int(size);
    if (rng.random() < darkness[py * size + px] / peak) points.push({ x: px, y: py });
  }
  return points;
}

/**
 * Lloyd's relaxation with darkness-weighted centroids: repeatedly reassign each
 * inked pixel to its nearest point and move each point to the weighted centroid
 * of its pixels, so points spread to evenly cover the dark areas.
 */
function lloydRelax(points: Point[], darkness: Float32Array, size: number, iterations: number): Point[] {
  // Precompute the inked pixels once — white pixels never pull a centroid.
  const inked: { x: number; y: number; weight: number }[] = [];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const weight = darkness[py * size + px];
      if (weight > 1e-4) inked.push({ x: px, y: py, weight });
    }
  }

  let current = points;
  const stopMovePx = 0.5;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const tree = new KdTree(current);
    const count = current.length;
    const weightSum = new Float64Array(count);
    const xSum = new Float64Array(count);
    const ySum = new Float64Array(count);
    for (const pixel of inked) {
      const nearest = tree.nearest(pixel, 1)[0];
      weightSum[nearest] += pixel.weight;
      xSum[nearest] += pixel.weight * pixel.x;
      ySum[nearest] += pixel.weight * pixel.y;
    }
    let maxMoveSq = 0;
    const next = current.map((point, index) => {
      if (weightSum[index] === 0) return { ...point };
      const moved = { x: xSum[index] / weightSum[index], y: ySum[index] / weightSum[index] };
      const dx = moved.x - point.x;
      const dy = moved.y - point.y;
      maxMoveSq = Math.max(maxMoveSq, dx * dx + dy * dy);
      return moved;
    });
    current = next;
    if (iteration >= 5 && maxMoveSq < stopMovePx * stopMovePx) break;
  }
  return current;
}

/** Drop points closer than `minDist` to an already-kept point (pen-width spacing). */
function dedupeClose(points: Point[], minDist: number): Point[] {
  if (minDist <= 0 || points.length < 2) return points;
  const tree = new KdTree(points);
  const keep = new Array<boolean>(points.length).fill(true);
  for (let i = 0; i < points.length; i++) {
    if (!keep[i]) continue;
    for (const j of tree.withinRadius(points[i], minDist)) {
      if (j !== i && keep[j]) keep[j] = false;
    }
  }
  return points.filter((_, index) => keep[index]);
}

/** Greedy nearest-neighbour tour over the stipple points, returning visit order. */
function nearestNeighborTour(points: Point[]): number[] {
  const count = points.length;
  if (count === 0) return [];
  const tree = new KdTree(points);
  const visited = new Array<boolean>(count).fill(false);

  let start = 0;
  let bestKey = Infinity;
  for (let i = 0; i < count; i++) {
    const key = points[i].x + points[i].y;
    if (key < bestKey) {
      bestKey = key;
      start = i;
    }
  }

  const order = [start];
  visited[start] = true;
  let current = start;
  for (let step = 1; step < count; step++) {
    const next = tree.nearest(points[current], 1, (index) => visited[index])[0];
    if (next === undefined) break;
    visited[next] = true;
    order.push(next);
    current = next;
  }
  return order;
}

/** Catmull-Rom spline through the points (endpoints duplicated), `subdiv` samples per span. */
function catmullRom(points: Point[], subdiv: number): Point[] {
  if (points.length < 4 || subdiv <= 1) return points.map((point) => ({ ...point }));
  const padded = [points[0], ...points, points[points.length - 1]];
  const result: Point[] = [];
  for (let i = 1; i < padded.length - 2; i++) {
    const [p0, p1, p2, p3] = [padded[i - 1], padded[i], padded[i + 1], padded[i + 2]];
    for (let step = 0; step < subdiv; step++) {
      const t = step / subdiv;
      const t2 = t * t;
      const t3 = t2 * t;
      const a = -0.5 * t3 + t2 - 0.5 * t;
      const b = 1.5 * t3 - 2.5 * t2 + 1;
      const c = -1.5 * t3 + 2 * t2 + 0.5 * t;
      const d = 0.5 * t3 - 0.5 * t2;
      result.push({
        x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
      });
    }
  }
  result.push({ ...points[points.length - 1] });
  return result;
}

/** Split a polyline wherever a single step exceeds `maxJump` (breaks pen-drag artifacts). */
function splitLongSegments(line: Polyline, maxJump: number): Polyline[] {
  const pieces: Polyline[] = [];
  let current: Point[] = line.length ? [line[0]] : [];
  for (let i = 1; i < line.length; i++) {
    if (distanceBetween(line[i - 1], line[i]) > maxJump) {
      if (current.length >= 2) pieces.push(current);
      current = [line[i]];
    } else {
      current.push(line[i]);
    }
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── greedy error-guided scribble (scribble_lineart) ──

function scribblePaths(darkness: Float32Array, size: number, options: ResolvedOptions, rng: Rng): Polyline[] {
  const target = new Float32Array(darkness.length);
  for (let i = 0; i < darkness.length; i++) target[i] = Math.min(darkness[i], options.maxDarkness);
  const drawn = new Float32Array(darkness.length);
  const pen = options.penBlackness / 255;
  const cell = Math.max(1, Math.floor(size * 0.1));
  const checkEvery = Math.max(1, Math.floor(options.maxSteps / 100));

  const seedZone = worstZone(target, drawn, size, cell);
  let x = seedZone.x;
  let y = seedZone.y;
  const paths: Point[][] = [[{ x, y }]];

  for (let step = 1; step <= options.maxSteps; step++) {
    if (step % checkEvery === 0 && worstZone(target, drawn, size, cell).error <= 0) break;

    const xi = clamp(Math.floor(x), 0, size - 1);
    const yi = clamp(Math.floor(y), 0, size - 1);
    const remaining = Math.max(0, target[yi * size + xi] - drawn[yi * size + xi]);
    const stepLen = options.baseSegmentPx + options.maxSegmentPx * (1 - remaining);

    const best = bestScribbleStroke(target, drawn, size, x, y, stepLen, pen, options, rng);
    if (best.score > 0) {
      const zone = worstZone(target, drawn, size, cell);
      if (zone.error <= 0) break;
      x = zone.x;
      y = zone.y;
      paths.push([{ x, y }]);
      continue;
    }

    inkSegment(drawn, size, x, y, best.x, best.y, pen);
    x = best.x;
    y = best.y;
    paths[paths.length - 1].push({ x, y });
  }

  return paths.filter((path) => path.length >= 2).map((path) => midpointQuadSmooth(path, options.smoothSubdiv));
}

/** Probe `angleSamples` random directions and return the stroke that best reduces error. */
function bestScribbleStroke(
  target: Float32Array,
  drawn: Float32Array,
  size: number,
  x: number,
  y: number,
  stepLen: number,
  pen: number,
  options: ResolvedOptions,
  rng: Rng,
): { x: number; y: number; score: number } {
  let bestScore = Infinity;
  let bestX = x;
  let bestY = y;
  for (let sample = 0; sample < options.angleSamples; sample++) {
    const angle = rng.uniform(0, 2 * Math.PI);
    const length = Math.max(options.baseSegmentPx, 0.5 * stepLen + 0.5 * Math.abs(rng.normal()) * stepLen);
    const endX = clamp(x + length * Math.cos(angle), 0, size - 1);
    const endY = clamp(y + length * Math.sin(angle), 0, size - 1);
    const score = scoreStroke(target, drawn, size, x, y, endX, endY, pen);
    if (score < bestScore) {
      bestScore = score;
      bestX = endX;
      bestY = endY;
    }
  }
  return { x: bestX, y: bestY, score: bestScore };
}

/** Mean over the segment of |drawn+pen − target| − |drawn − target| (negative = helpful). */
function scoreStroke(
  target: Float32Array,
  drawn: Float32Array,
  size: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pen: number,
): number {
  const steps = Math.max(Math.round(Math.abs(x1 - x0)), Math.round(Math.abs(y1 - y0)), 1);
  let total = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = clamp(Math.round(x0 + t * (x1 - x0)), 0, size - 1);
    const py = clamp(Math.round(y0 + t * (y1 - y0)), 0, size - 1);
    const index = py * size + px;
    total += Math.abs(drawn[index] + pen - target[index]) - Math.abs(drawn[index] - target[index]);
  }
  return total / (steps + 1);
}

/** Deposit `pen` ink along the segment into the `drawn` buffer. */
function inkSegment(drawn: Float32Array, size: number, x0: number, y0: number, x1: number, y1: number, pen: number): void {
  const steps = Math.max(Math.round(Math.abs(x1 - x0)), Math.round(Math.abs(y1 - y0)), 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = clamp(Math.round(x0 + t * (x1 - x0)), 0, size - 1);
    const py = clamp(Math.round(y0 + t * (y1 - y0)), 0, size - 1);
    drawn[py * size + px] += pen;
  }
}

/** Coarse block-mean scan: the most under-drawn cell and its remaining error. */
function worstZone(
  target: Float32Array,
  drawn: Float32Array,
  size: number,
  cell: number,
): { error: number; x: number; y: number } {
  const cells = Math.floor(size / cell);
  if (cells === 0) return { error: 0, x: size / 2, y: size / 2 };
  let worst = -Infinity;
  let worstX = size / 2;
  let worstY = size / 2;
  for (let by = 0; by < cells; by++) {
    for (let bx = 0; bx < cells; bx++) {
      let sum = 0;
      for (let dy = 0; dy < cell; dy++) {
        const rowBase = (by * cell + dy) * size + bx * cell;
        for (let dx = 0; dx < cell; dx++) sum += target[rowBase + dx] - drawn[rowBase + dx];
      }
      const mean = sum / (cell * cell);
      if (mean > worst) {
        worst = mean;
        worstX = bx * cell + (cell >> 1);
        worstY = by * cell + (cell >> 1);
      }
    }
  }
  return { error: worst, x: worstX, y: worstY };
}

/** Round corners by chaining quadratic Béziers through segment midpoints. */
function midpointQuadSmooth(points: Point[], subdiv: number): Point[] {
  if (points.length < 3 || subdiv <= 1) return points.map((point) => ({ ...point }));
  const result: Point[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i++) {
    const start = midpoint(points[i - 1], points[i]);
    const control = points[i];
    const end = midpoint(points[i], points[i + 1]);
    for (let step = 0; step < subdiv; step++) {
      const t = step / subdiv;
      const inv = 1 - t;
      result.push({
        x: inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x,
        y: inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y,
      });
    }
  }
  result.push({ ...points[points.length - 1] });
  return result;
}

function midpoint(a: Point, b: Point): Point {
  return { x: 0.5 * (a.x + b.x), y: 0.5 * (a.y + b.y) };
}

// ── long-stroke line art (pintr_lineart) ──

function pintrPaths(darkness: Float32Array, size: number, options: ResolvedOptions, rng: Rng): Polyline[] {
  const remaining = new Float32Array(darkness);
  let cx = size / 2;
  let cy = size / 2;
  const single = options.singleLine;
  const chained: Point[] = [{ x: cx, y: cy }];
  const segments: Polyline[] = [];

  for (let line = 0; line < options.totalLines; line++) {
    let fromX = cx;
    let fromY = cy;
    if (!single) {
      const darkestStart = darkestOf(remaining, size, options.candidates, rng);
      const currentDarkness = remaining[clamp(Math.floor(cy), 0, size - 1) * size + clamp(Math.floor(cx), 0, size - 1)];
      if (darkestStart.value > currentDarkness) {
        fromX = darkestStart.x;
        fromY = darkestStart.y;
      }
    }

    const to = bestPintrEndpoint(remaining, size, fromX, fromY, options.candidates, rng);
    consumeDarkness(remaining, size, fromX, fromY, to.x, to.y, options.penOpacity);

    if (single) {
      chained.push({ x: to.x, y: to.y });
    } else {
      segments.push([{ x: fromX, y: fromY }, { x: to.x, y: to.y }]);
    }
    cx = to.x;
    cy = to.y;
  }

  return single ? [chained] : segments;
}

/** Of `candidates` random pixels, the darkest one in the remaining map. */
function darkestOf(remaining: Float32Array, size: number, candidates: number, rng: Rng): { x: number; y: number; value: number } {
  let best = { x: 0, y: 0, value: -Infinity };
  for (let i = 0; i < candidates; i++) {
    const px = rng.int(size);
    const py = rng.int(size);
    const value = remaining[py * size + px];
    if (value > best.value) best = { x: px, y: py, value };
  }
  return best;
}

/** Among `candidates` random endpoints, the segment with the highest mean remaining darkness. */
function bestPintrEndpoint(
  remaining: Float32Array,
  size: number,
  fromX: number,
  fromY: number,
  candidates: number,
  rng: Rng,
): { x: number; y: number } {
  let best = { x: fromX, y: fromY };
  let bestScore = -Infinity;
  for (let i = 0; i < candidates; i++) {
    const endX = rng.int(size);
    const endY = rng.int(size);
    const score = meanAlongSegment(remaining, size, fromX, fromY, endX, endY);
    if (score > bestScore) {
      bestScore = score;
      best = { x: endX, y: endY };
    }
  }
  return best;
}

function meanAlongSegment(map: Float32Array, size: number, x0: number, y0: number, x1: number, y1: number): number {
  const steps = Math.max(Math.round(Math.abs(x1 - x0)), Math.round(Math.abs(y1 - y0)), 1);
  let total = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = clamp(Math.round(x0 + t * (x1 - x0)), 0, size - 1);
    const py = clamp(Math.round(y0 + t * (y1 - y0)), 0, size - 1);
    total += map[py * size + px];
  }
  return total / (steps + 1);
}

/** Subtract `opacity` of remaining darkness along the drawn stroke. */
function consumeDarkness(map: Float32Array, size: number, x0: number, y0: number, x1: number, y1: number, opacity: number): void {
  const steps = Math.max(Math.round(Math.abs(x1 - x0)), Math.round(Math.abs(y1 - y0)), 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = clamp(Math.round(x0 + t * (x1 - x0)), 0, size - 1);
    const py = clamp(Math.round(y0 + t * (y1 - y0)), 0, size - 1);
    const index = py * size + px;
    map[index] = Math.max(map[index] - opacity, 0);
  }
}
