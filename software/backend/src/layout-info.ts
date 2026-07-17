// Maps plotter-utils' PaperLayoutResult down to the scalar LayoutInfo the UI
// and queue persist — dropping the placed-drawing geometry. Shared by the
// submission service and the pipeline worker so the two never diverge.

import { PaperLayoutResult } from "plotter-utils";
import { LayoutInfo } from "./queue";

/** Strip the geometry off a layout result, leaving the metadata the UI needs. */
export function toLayoutInfo(layout: PaperLayoutResult | null): LayoutInfo | null {
  if (!layout) return null;
  return {
    orientation: layout.orientation,
    paperWidthMm: layout.paperWidthMm,
    paperHeightMm: layout.paperHeightMm,
    paddingMm: layout.paddingMm,
    drawableWidthMm: layout.drawableWidthMm,
    drawableHeightMm: layout.drawableHeightMm,
    contentWidthMm: layout.contentWidthMm,
    contentHeightMm: layout.contentHeightMm,
    positionXMm: layout.positionXMm,
    positionYMm: layout.positionYMm,
    appliedScale: layout.appliedScale,
    maxFitScale: layout.maxFitScale,
    fillFraction: layout.fillFraction,
    mirrorX: layout.mirrorX,
    overflows: layout.overflows,
  };
}
