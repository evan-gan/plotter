// High-level one-call pipelines used by the backend and CLI tools:
// SVG text → (optimize) → G-code + preview SVG + stats.

import { Drawing } from "./types";
import { svgToDrawing, SvgParseOptions } from "./svg-parse";
import { gcodeToDrawing } from "./gcode-parse";
import { drawingToGcode, GcodeGenerateOptions } from "./gcode-generate";
import { drawingToSvg } from "./svg-generate";
import { optimizePolylines, OptimizeOptions, OptimizeStats } from "./optimizer";

export interface PreparedPlot {
  drawing: Drawing;
  gcode: string;
  previewSvg: string;
  stats: OptimizeStats | null;
}

export interface PreparePlotOptions {
  svg?: SvgParseOptions;
  gcode?: GcodeGenerateOptions;
  optimizer?: OptimizeOptions;
  /** Skip the optimizer and plot paths in document order. */
  optimize?: boolean;
}

/** SVG source → ready-to-stream G-code (optionally path-optimized). */
export function prepareSvgPlot(svgText: string, options: PreparePlotOptions = {}): PreparedPlot {
  const parsed = svgToDrawing(svgText, options.svg);
  return finishPlot(parsed, options);
}

/** Existing G-code → Drawing + preview (and optionally re-optimized G-code). */
export function prepareGcodePlot(gcodeText: string, options: PreparePlotOptions = {}): PreparedPlot {
  const parsed = gcodeToDrawing(gcodeText);
  if (options.optimize === false) {
    // Keep the original program byte-for-byte; just derive the preview.
    return { drawing: parsed, gcode: gcodeText, previewSvg: drawingToSvg(parsed), stats: null };
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
  return {
    drawing,
    gcode: drawingToGcode(drawing, options.gcode),
    previewSvg: drawingToSvg(drawing),
    stats,
  };
}
