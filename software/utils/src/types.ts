// Shared geometry types for the converter/optimizer pipeline.
// All coordinates are millimetres in the plotter's frame (Y up, origin at the
// plotter's 0,0). SVG input is flipped/scaled into this frame at parse time.

export interface Point {
  x: number;
  y: number;
}

/** An ordered run of pen-down points. The pen travels up between polylines. */
export type Polyline = Point[];

/** A full plot: the polylines plus the bounding size they were fitted to. */
export interface Drawing {
  polylines: Polyline[];
  /** Width/height of the drawing's bounding box in mm (for previews). */
  widthMm: number;
  heightMm: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Total pen-down length of one polyline in mm. */
export function polylineLength(line: Polyline): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += distance(line[i - 1], line[i]);
  return total;
}

/**
 * Total pen-up (travel) distance of a plot in mm: from `start` to the first
 * polyline, then between consecutive polylines. This is the quantity the
 * optimizer minimises — with a fixed path set the pen-lift count is constant,
 * so distance alone ranks orderings.
 */
export function penUpDistance(polylines: Polyline[], start: Point = { x: 0, y: 0 }): number {
  let total = 0;
  let position = start;
  for (const line of polylines) {
    if (line.length === 0) continue;
    total += distance(position, line[0]);
    position = line[line.length - 1];
  }
  return total;
}

export function boundingBox(polylines: Polyline[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of polylines) {
    for (const point of line) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
