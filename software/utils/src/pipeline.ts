// High-level one-call pipelines used by the backend and CLI tools:
// SVG text → (optimize) → (place on paper) → G-code + preview SVG + stats.

import { Drawing } from "./types";
import { svgToDrawing, SvgParseOptions } from "./svg-parse";
import { gcodeToDrawing } from "./gcode-parse";
import { drawingToGcode, GcodeGenerateOptions } from "./gcode-generate";
import { drawingToSvg } from "./svg-generate";
import { optimizePolylines, OptimizeOptions, OptimizeStats } from "./optimizer";
import { layoutOnPaper, PaperLayoutOptions, PaperLayoutResult } from "./layout";

export interface PreparedPlot {
  drawing: Drawing;
  gcode: string;
  previewSvg: string;
  stats: OptimizeStats | null;
  /** Paper-placement metadata when a `paper` layout was applied. */
  layout: PaperLayoutResult | null;
}

export interface PreparePlotOptions {
  svg?: SvgParseOptions;
  gcode?: GcodeGenerateOptions;
  optimizer?: OptimizeOptions;
  /** Skip the optimizer and plot paths in document order. */
  optimize?: boolean;
  /**
   * Place the (optimized) drawing on a physical sheet: choose orientation,
   * scale to fit, mirror, and anchor to the bottom-right corner. Omit to emit
   * the drawing in its natural machine coordinates (legacy behaviour).
   */
  paper?: PaperLayoutOptions;
}

/** SVG source → ready-to-stream G-code (optionally path-optimized + placed). */
export function prepareSvgPlot(svgText: string, options: PreparePlotOptions = {}): PreparedPlot {
  const parsed = svgToDrawing(svgText, options.svg);
  return finishPlot(parsed, options);
}

/** Existing G-code → Drawing + preview (and optionally re-optimized + placed). */
export function prepareGcodePlot(gcodeText: string, options: PreparePlotOptions = {}): PreparedPlot {
  const parsed = gcodeToDrawing(gcodeText);
  if (options.optimize === false) {
    // Keep the original program byte-for-byte; just derive the preview. Paper
    // placement is skipped here because it would require regenerating the file
    // and discarding the author's own coordinates/feeds.
    return { drawing: parsed, gcode: gcodeText, previewSvg: drawingToSvg(parsed), stats: null, layout: null };
  }
  return finishPlot(parsed, options);
}

function finishPlot(parsed: Drawing, options: PreparePlotOptions): PreparedPlot {
  const shouldOptimize = options.optimize !== false;
  let drawing = parsed;
  let stats: OptimizeStats | null = null;
  if (shouldOptimize) {
    const result = optimizePolylines(parsed.polylines, options.optimizer);
    drawing = { ...parsed, polylines: result.polylines };
    stats = result.stats;
  }

  // The preview always shows the artwork in its natural orientation (never the
  // machine-mirrored placement), so the thumbnail reads right-side up. G-code
  // is emitted from the placed drawing so the plot lands where we want it.
  const layout = options.paper ? layoutOnPaper(drawing, options.paper) : null;
  const placed = layout ? layout.drawing : drawing;
  return {
    drawing,
    gcode: drawingToGcode(placed, options.gcode),
    previewSvg: drawingToSvg(drawing),
    stats,
    layout,
  };
}
