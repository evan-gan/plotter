// Drawing → SVG text, for previews (gallery thumbnails, queue cards) and for
// the G-code → SVG direction of the converter pair.

import { Drawing, boundingBox } from "./types";

export interface SvgGenerateOptions {
  strokeWidthMm?: number;
  stroke?: string;
  /** Also draw the pen-up travel moves as a dashed overlay (debugging). */
  showTravel?: boolean;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * Render a Drawing as a standalone SVG document. The plotter frame is Y-up
 * but SVG is Y-down, so points are flipped back; physical size is preserved
 * via mm units on width/height.
 */
export function drawingToSvg(drawing: Drawing, options: SvgGenerateOptions = {}): string {
  const strokeWidth = options.strokeWidthMm ?? 0.4;
  const stroke = options.stroke ?? "#111";
  const box = boundingBox(drawing.polylines);
  const width = Math.max(box.maxX - box.minX, 1e-3);
  const height = Math.max(box.maxY - box.minY, 1e-3);
  const pad = strokeWidth; // keep round caps from clipping at the edges

  const paths = drawing.polylines
    .filter((line) => line.length >= 2)
    .map((line) => {
      const data = line
        .map((point, index) =>
          `${index === 0 ? "M" : "L"}${formatNumber(point.x - box.minX)} ${formatNumber(box.maxY - point.y)}`)
        .join("");
      return `<path d="${data}"/>`;
    });

  const travel: string[] = [];
  if (options.showTravel) {
    let previous: { x: number; y: number } | null = null;
    for (const line of drawing.polylines) {
      if (line.length === 0) continue;
      if (previous) {
        travel.push(
          `<line x1="${formatNumber(previous.x - box.minX)}" y1="${formatNumber(box.maxY - previous.y)}" ` +
          `x2="${formatNumber(line[0].x - box.minX)}" y2="${formatNumber(box.maxY - line[0].y)}"/>`
        );
      }
      previous = line[line.length - 1];
    }
  }

  const viewWidth = formatNumber(width + 2 * pad);
  const viewHeight = formatNumber(height + 2 * pad);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${viewWidth}mm" height="${viewHeight}mm" ` +
      `viewBox="${formatNumber(-pad)} ${formatNumber(-pad)} ${viewWidth} ${viewHeight}">`,
    `<g fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    ...paths,
    "</g>",
    ...(travel.length
      ? [`<g fill="none" stroke="#e33" stroke-width="${strokeWidth / 2}" stroke-dasharray="1 1">`, ...travel, "</g>"]
      : []),
    "</svg>",
  ].join("\n");
}
