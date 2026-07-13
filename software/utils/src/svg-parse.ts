// SVG document → Drawing (polylines in plotter mm, Y up).
//
// Dependency-free: a small tag scanner walks the XML, keeping a transform
// stack, and converts the drawable elements (path, line, polyline, polygon,
// rect, circle, ellipse) into flattened polylines. Non-drawable containers
// (defs/clipPath/mask/symbol/style/metadata) are skipped entirely. <use>,
// text, images, strokes/fills-as-area are out of scope for a pen plotter.
//
// Coordinate policy: the SVG is parsed in user units, then uniformly scaled
// to fit the requested work area (preserving aspect ratio) and flipped from
// SVG's Y-down to the plotter's Y-up frame with the drawing's bottom-left at
// the origin. This makes physical output size explicit rather than trusting
// the file's unit soup.

import { Drawing, Point, Polyline, boundingBox } from "./types";
import { parsePathData, CURVE_TOLERANCE } from "./svg-path";

/** 2×3 affine transform [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyMatrix(m: Matrix, point: Point): Point {
  return { x: m[0] * point.x + m[2] * point.y + m[4], y: m[1] * point.x + m[3] * point.y + m[5] };
}

/** Parse an SVG `transform` attribute into a single matrix. */
export function parseTransform(text: string): Matrix {
  let result: Matrix = [...IDENTITY] as Matrix;
  const callRegex = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(text)) !== null) {
    const args = (match[2].match(/-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/g) || []).map(Number);
    result = multiply(result, transformCall(match[1], args));
  }
  return result;
}

function transformCall(name: string, args: number[]): Matrix {
  switch (name) {
    case "matrix":
      return args.length === 6 ? (args as Matrix) : [...IDENTITY] as Matrix;
    case "translate":
      return [1, 0, 0, 1, args[0] || 0, args[1] || 0];
    case "scale":
      return [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    case "rotate": {
      const angle = ((args[0] || 0) * Math.PI) / 180;
      const rotation: Matrix = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
      if (args.length >= 3) {
        // rotate(a, cx, cy) = translate(cx,cy) · rotate(a) · translate(-cx,-cy)
        const toOrigin: Matrix = [1, 0, 0, 1, -args[1], -args[2]];
        const back: Matrix = [1, 0, 0, 1, args[1], args[2]];
        return multiply(multiply(back, rotation), toOrigin);
      }
      return rotation;
    }
    case "skewX":
      return [1, 0, Math.tan(((args[0] || 0) * Math.PI) / 180), 1, 0, 0];
    case "skewY":
      return [1, Math.tan(((args[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
    default:
      return [...IDENTITY] as Matrix;
  }
}

interface Tag {
  name: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
  closing: boolean;
}

/** Scan the document into a flat list of open/close tags (content ignored). */
function scanTags(svgText: string): Tag[] {
  const tags: Tag[] = [];
  // Strip comments, CDATA, doctype, and processing instructions first.
  const cleaned = svgText
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<[!?][^>]*>/g, "");
  const tagRegex = /<\s*(\/?)\s*([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(cleaned)) !== null) {
    const attributes: Record<string, string> = {};
    const attrRegex = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRegex.exec(match[3])) !== null) {
      attributes[attr[1].toLowerCase()] = attr[3] ?? attr[4] ?? "";
    }
    tags.push({
      name: match[2].toLowerCase(),
      attributes,
      selfClosing: match[4] === "/",
      closing: match[1] === "/",
    });
  }
  return tags;
}

const SKIP_CONTAINERS = new Set(["defs", "clippath", "mask", "symbol", "style", "metadata", "title", "desc", "pattern", "marker"]);

/** Convert one drawable element into polylines in its LOCAL user units. */
function elementPolylines(tag: Tag, tolerance: number): Polyline[] {
  const attr = (name: string) => tag.attributes[name];
  const num = (name: string, fallback = 0) => {
    const value = parseFloat(attr(name) ?? "");
    return Number.isFinite(value) ? value : fallback;
  };
  switch (tag.name) {
    case "path":
      return attr("d") ? parsePathData(attr("d"), tolerance) : [];
    case "line":
      return [[{ x: num("x1"), y: num("y1") }, { x: num("x2"), y: num("y2") }]];
    case "polyline":
    case "polygon": {
      const values = (attr("points")?.match(/-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/g) || []).map(Number);
      const points: Polyline = [];
      for (let i = 0; i + 1 < values.length; i += 2) points.push({ x: values[i], y: values[i + 1] });
      if (points.length < 2) return [];
      if (tag.name === "polygon") points.push({ ...points[0] });
      return [points];
    }
    case "rect": {
      const x = num("x"), y = num("y"), width = num("width"), height = num("height");
      if (width <= 0 || height <= 0) return [];
      return [[
        { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }, { x, y },
      ]];
    }
    case "circle":
    case "ellipse": {
      const centerX = num("cx"), centerY = num("cy");
      const radiusX = tag.name === "circle" ? num("r") : num("rx");
      const radiusY = tag.name === "circle" ? num("r") : num("ry");
      if (radiusX <= 0 || radiusY <= 0) return [];
      const stepAngle = 2 * Math.sqrt((2 * tolerance) / Math.max(radiusX, radiusY));
      const segments = Math.max(8, Math.min(4096, Math.ceil((2 * Math.PI) / stepAngle)));
      const points: Polyline = [];
      for (let segment = 0; segment <= segments; segment++) {
        const theta = (2 * Math.PI * segment) / segments;
        points.push({ x: centerX + radiusX * Math.cos(theta), y: centerY + radiusY * Math.sin(theta) });
      }
      return [points];
    }
    default:
      return [];
  }
}

/** Walk the tag list, applying nested transforms, collecting raw polylines. */
function collectPolylines(tags: Tag[], tolerance: number): Polyline[] {
  const polylines: Polyline[] = [];
  const transformStack: Matrix[] = [[...IDENTITY] as Matrix];
  let skipDepth = 0; // >0 while inside a non-drawable container

  for (const tag of tags) {
    if (tag.closing) {
      if (skipDepth > 0 && SKIP_CONTAINERS.has(tag.name)) skipDepth--;
      else if (skipDepth === 0 && transformStack.length > 1) transformStack.pop();
      continue;
    }
    if (skipDepth > 0) {
      if (!tag.selfClosing && SKIP_CONTAINERS.has(tag.name)) skipDepth++;
      continue;
    }
    if (SKIP_CONTAINERS.has(tag.name)) {
      if (!tag.selfClosing) skipDepth++;
      continue;
    }

    const parent = transformStack[transformStack.length - 1];
    const local = tag.attributes.transform ? multiply(parent, parseTransform(tag.attributes.transform)) : parent;

    for (const line of elementPolylines(tag, tolerance)) {
      if (line.length >= 2) polylines.push(line.map((point) => applyMatrix(local, point)));
    }
    // Container elements (g, svg, a, ...) push their transform for children.
    if (!tag.selfClosing) transformStack.push([...local] as Matrix);
  }
  return polylines;
}

export interface SvgParseOptions {
  /** Work area the drawing is scaled to fit (aspect preserved). */
  fitWidthMm?: number;
  fitHeightMm?: number;
  /** Curve flattening tolerance in user units. */
  toleranceMm?: number;
}

/**
 * Parse SVG text into a Drawing in plotter mm (Y up, bottom-left at 0,0),
 * uniformly scaled to fit the given work area.
 *
 * @throws Error when the SVG contains nothing drawable.
 */
export function svgToDrawing(svgText: string, options: SvgParseOptions = {}): Drawing {
  const fitWidth = options.fitWidthMm ?? 100;
  const fitHeight = options.fitHeightMm ?? 100;
  const tolerance = options.toleranceMm ?? CURVE_TOLERANCE;

  const raw = collectPolylines(scanTags(svgText), tolerance);
  const box = boundingBox(raw);
  const sourceWidth = box.maxX - box.minX;
  const sourceHeight = box.maxY - box.minY;
  if (raw.length === 0 || (sourceWidth <= 0 && sourceHeight <= 0)) {
    throw new Error("SVG contains no drawable geometry (paths/shapes) — text and <use> are not supported.");
  }

  // Uniform scale to fit; degenerate axes (a pure horizontal line) still work.
  const scale = Math.min(
    sourceWidth > 0 ? fitWidth / sourceWidth : Infinity,
    sourceHeight > 0 ? fitHeight / sourceHeight : Infinity
  );
  const polylines = raw.map((line) =>
    line.map((point) => ({
      x: (point.x - box.minX) * scale,
      // Flip Y: SVG grows downward, the plotter grows upward.
      y: (box.maxY - point.y) * scale,
    }))
  );
  return {
    // NB: wrap in a lambda — a bare `map(dedupeConsecutive)` would pass the
    // array index as the epsilon argument, collapsing later polylines.
    polylines: polylines.map((line) => dedupeConsecutive(line)).filter((line) => line.length >= 2),
    widthMm: sourceWidth * scale,
    heightMm: sourceHeight * scale,
  };
}

/** Drop consecutive duplicate points (they confuse chaining and waste moves). */
export function dedupeConsecutive(line: Polyline, epsilon = 1e-6): Polyline {
  const result: Polyline = [];
  for (const point of line) {
    const last = result[result.length - 1];
    if (!last || Math.abs(last.x - point.x) > epsilon || Math.abs(last.y - point.y) > epsilon) {
      result.push(point);
    }
  }
  return result;
}
