// Paper placement: take a Drawing in its natural mm and place it on a physical
// sheet so plots are easy to align by hand.
//
// The machine frame (see types.ts) has its origin (0,0) at the plotter's start
// position, drawing into +X/+Y. Physically the head starts half an inch in from
// the paper's BOTTOM-RIGHT corner, so on the paper +X points LEFT and +Y points
// UP. Handled here:
//   • the drawing is scaled to fit the padded sheet (shrunk if it would
//     overflow, never enlarged past 1:1 unless asked);
//   • it can be freely positioned on the page (admin drag), defaulting to the
//     bottom-right corner nearest the start;
//   • the paper orientation (portrait/landscape) is chosen to fit the drawing
//     largest, or forced by the admin;
//   • coordinates are authored in the operator's view (Y-down, the sheet as you
//     look at it) and reflected into the machine frame, which makes the plot
//     read the right way round without any separate "mirror" step.
//
// The `mirrorX` flag selects the physical mounting: true (default) = head at the
// bottom-right corner with +X pointing left; false = legacy bottom-left origin.

import { Drawing, boundingBox } from "./types";

export type PaperOrientation = "portrait" | "landscape";

export interface PaperLayoutOptions {
  /** The sheet's shorter side in mm (e.g. US Letter width). */
  paperShortMm: number;
  /** The sheet's longer side in mm (e.g. US Letter height). */
  paperLongMm: number;
  /** Blank margin kept on every edge of the sheet, mm (e.g. 12.7 = 0.5"). */
  paddingMm: number;
  /**
   * How much of the largest fit to use, as a fraction in (0,1].
   * 1 = fill the padded area; smaller = leave the drawing smaller.
   * Omit for the default: fill only when the drawing must shrink to fit,
   * otherwise keep it at natural 1:1 size (never auto-enlarge).
   */
  fillFraction?: number;
  /** Force portrait/landscape; omit to auto-pick the orientation that fits largest. */
  orientation?: PaperOrientation;
  /**
   * Top-left of the drawing's bounding box in the operator's view (mm from the
   * page's top-left corner, Y-down). Omit to anchor the drawing to the padded
   * bottom-right corner (nearest the plotter start). Values are clamped to keep
   * the drawing on the sheet is NOT enforced — the admin may drag it past the
   * margin deliberately; callers surface an overflow warning instead.
   */
  positionXMm?: number;
  positionYMm?: number;
  /** Mirror handling / mounting (see file header). Default true. */
  mirrorX?: boolean;
}

export interface PaperLayoutResult {
  /** The placed drawing in machine mm (origin = plotter start). */
  drawing: Drawing;
  orientation: PaperOrientation;
  /** Paper dimensions in the operator's view for the chosen orientation, mm. */
  paperWidthMm: number;
  paperHeightMm: number;
  paddingMm: number;
  /** Padded printable area size (paper minus 2× padding), mm. */
  drawableWidthMm: number;
  drawableHeightMm: number;
  /** Placed drawing bounding-box size, mm. */
  contentWidthMm: number;
  contentHeightMm: number;
  /** Resolved top-left of the drawing in the operator's view, mm. */
  positionXMm: number;
  positionYMm: number;
  /** Scale applied to the source (machine mm per source mm). */
  appliedScale: number;
  /** The largest scale that still fits the padded area (fillFraction = 1). */
  maxFitScale: number;
  /** Fraction of the max fit actually used, in (0,1]. */
  fillFraction: number;
  mirrorX: boolean;
  /** True when the placed drawing extends past the padded printable area. */
  overflows: boolean;
}

/**
 * Convert a live machine position (mm) into the operator's page view (mm from
 * the page's top-left, Y-down) — the inverse of the placement reflection. Used
 * to draw the pen head on the paper canvas so the operator can see where it is.
 */
export function machineToPaperView(
  machineXMm: number,
  machineYMm: number,
  paper: { paperWidthMm: number; paperHeightMm: number; paddingMm: number; mirrorX: boolean }
): { xMm: number; yMm: number } {
  const originX = paper.mirrorX ? paper.paperWidthMm - paper.paddingMm : paper.paddingMm;
  const originY = paper.paperHeightMm - paper.paddingMm;
  return {
    xMm: paper.mirrorX ? originX - machineXMm : originX + machineXMm,
    yMm: originY - machineYMm,
  };
}

interface ScoredOrientation {
  name: PaperOrientation;
  widthMm: number;
  heightMm: number;
  drawableWidthMm: number;
  drawableHeightMm: number;
  maxFitScale: number;
}

/** Score one orientation: paper dims in the operator view + its best-fit scale. */
function scoreOrientation(
  name: PaperOrientation,
  widthMm: number,
  heightMm: number,
  paddingMm: number,
  sourceWidthMm: number,
  sourceHeightMm: number
): ScoredOrientation {
  const drawableWidthMm = Math.max(widthMm - 2 * paddingMm, 1e-9);
  const drawableHeightMm = Math.max(heightMm - 2 * paddingMm, 1e-9);
  const maxFitScale = Math.min(drawableWidthMm / sourceWidthMm, drawableHeightMm / sourceHeightMm);
  return { name, widthMm, heightMm, drawableWidthMm, drawableHeightMm, maxFitScale };
}

/**
 * Place a Drawing on the paper for hand-aligned plotting (see file header).
 *
 * @param drawing Source drawing in natural mm (Y up).
 * @param options Paper size, padding, and optional scale/orientation/position/mirror.
 * @returns The placed drawing plus the layout metadata needed to render an
 *          interactive paper canvas and a scale control.
 */
export function layoutOnPaper(drawing: Drawing, options: PaperLayoutOptions): PaperLayoutResult {
  const { paperShortMm, paperLongMm, paddingMm } = options;
  const mirrorX = options.mirrorX ?? true;

  const box = boundingBox(drawing.polylines);
  const sourceWidth = Math.max(box.maxX - box.minX, 1e-9);
  const sourceHeight = Math.max(box.maxY - box.minY, 1e-9);

  const orientations = [
    scoreOrientation("portrait", paperShortMm, paperLongMm, paddingMm, sourceWidth, sourceHeight),
    scoreOrientation("landscape", paperLongMm, paperShortMm, paddingMm, sourceWidth, sourceHeight),
  ];
  const chosen = options.orientation
    ? orientations.find((entry) => entry.name === options.orientation) ?? orientations[0]
    : orientations.reduce((best, entry) => (entry.maxFitScale > best.maxFitScale ? entry : best));

  const maxFitScale = chosen.maxFitScale;
  // Default: shrink to fit if needed, but never enlarge a drawing that already fits.
  const defaultFraction = Math.min(1, maxFitScale) / maxFitScale;
  const requestedFraction = options.fillFraction ?? defaultFraction;
  const fillFraction = Math.max(1e-3, Math.min(1, requestedFraction));
  const appliedScale = fillFraction * maxFitScale;

  const scaledWidth = sourceWidth * appliedScale;
  const scaledHeight = sourceHeight * appliedScale;

  // Position (operator view, mm from page top-left). Default anchors the drawing
  // to the padded corner nearest the plotter start: bottom-right when mirrored
  // (head at the bottom-right, +X left), bottom-left for the legacy mounting.
  const defaultPositionX = mirrorX ? chosen.widthMm - paddingMm - scaledWidth : paddingMm;
  const defaultPositionY = chosen.heightMm - paddingMm - scaledHeight;
  const positionX = options.positionXMm ?? defaultPositionX;
  const positionY = options.positionYMm ?? defaultPositionY;

  // Operator-view coordinates of the machine origin (the start corner).
  const originX = mirrorX ? chosen.widthMm - paddingMm : paddingMm;
  const originY = chosen.heightMm - paddingMm;

  const polylines = drawing.polylines.map((line) =>
    line.map((point) => {
      // Source is Y-up; convert to the operator view (Y-down from top-left).
      const localX = (point.x - box.minX) * appliedScale; // 0 = visual left
      const localY = (point.y - box.minY) * appliedScale; // 0 = visual bottom
      const operatorX = positionX + localX;
      const operatorY = positionY + (scaledHeight - localY);
      // Reflect the operator view into the machine frame.
      return {
        x: mirrorX ? originX - operatorX : operatorX - originX,
        y: originY - operatorY,
      };
    })
  );

  // Overflow: any part of the placed box outside the padded printable area.
  const overflows =
    positionX < paddingMm - 1e-6 ||
    positionY < paddingMm - 1e-6 ||
    positionX + scaledWidth > chosen.widthMm - paddingMm + 1e-6 ||
    positionY + scaledHeight > chosen.heightMm - paddingMm + 1e-6;

  return {
    drawing: { polylines, widthMm: scaledWidth, heightMm: scaledHeight },
    orientation: chosen.name,
    paperWidthMm: chosen.widthMm,
    paperHeightMm: chosen.heightMm,
    paddingMm,
    drawableWidthMm: chosen.drawableWidthMm,
    drawableHeightMm: chosen.drawableHeightMm,
    contentWidthMm: scaledWidth,
    contentHeightMm: scaledHeight,
    positionXMm: positionX,
    positionYMm: positionY,
    appliedScale,
    maxFitScale,
    fillFraction,
    mirrorX,
    overflows,
  };
}
