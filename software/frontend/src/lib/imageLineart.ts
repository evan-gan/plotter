// Browser glue for the plotter-utils photo → line-art converter. Handles the
// parts that need a DOM (decode + square-resize + luminance extraction via a
// canvas), then hands the darkness map to the pure-TS generator and returns an
// SVG string ready for the existing /api/estimate + /api/submit flow.

import {
  imageToLineart,
  computeDarkness,
  drawingToSvg,
  type ImageToLineartOptions,
  type LineartAlgorithm,
} from "plotter-utils";

export type { LineartAlgorithm };

export interface SketchSettings {
  /**
   * Fixed to "stipple" (dots joined into one TSP line). The other generators
   * still exist in plotter-utils but aren't exposed in the UI — stipple gives
   * the cleanest single-pen result. Kept on the settings object because the
   * converter takes it.
   */
  algorithm: LineartAlgorithm;
  contrast: number;
  gamma: number;
  /** Stipple point density — fewer points = faster plot, more abstract look. */
  density: number;
  seed: number;
}

/**
 * The three detail levels shown in the UI. Density is the point-count knob:
 * fewer points draw much faster (fewer dots + shorter TSP tour). "Fast" is the
 * default so a photo plots quickly out of the box.
 */
export const DETAIL_PRESETS: { label: string; density: number }[] = [
  { label: "Quick", density: 0.35 },
  { label: "Fast", density: 0.8 },
  { label: "Balanced", density: 1.6 },
  { label: "Detailed", density: 3.0 },
];

export const DEFAULT_SKETCH: SketchSettings = {
  algorithm: "stipple",
  contrast: 2.0,
  gamma: 1.4,
  density: DETAIL_PRESETS[0].density,
  seed: 0,
};

// Working resolution of the darkness grid. Larger = finer detail but slower in
// the browser (the generators are O(pixels) per iteration/step).
const WORK_SIZE_PX = 300;
const CANVAS_MM = 125;

/**
 * Draw an image source stretched into a square canvas and read back its
 * per-pixel luminance (ITU-R 601 luma), matching the reference `convert("L")`.
 */
function extractLuminance(source: CanvasImageSource, size: number): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not get a 2D canvas context to read the photo.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, size, size);
  const rgba = context.getImageData(0, 0, size, size).data;
  const luminance = new Float32Array(size * size);
  for (let pixel = 0; pixel < luminance.length; pixel++) {
    const offset = pixel * 4;
    luminance[pixel] = 0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2];
  }
  return luminance;
}

/**
 * Convert an image element/bitmap into a plottable sketch SVG.
 *
 * @param source Any canvas-drawable image (an <img>, ImageBitmap, or <video>).
 * @returns SVG document string (mm-sized) for the plot pipeline.
 */
export function imageToSketchSvg(source: CanvasImageSource, settings: SketchSettings): string {
  const luminance = extractLuminance(source, WORK_SIZE_PX);
  const options: ImageToLineartOptions = {
    algorithm: settings.algorithm,
    canvasMm: CANVAS_MM,
    contrast: settings.contrast,
    gamma: settings.gamma,
    seed: settings.seed,
    density: settings.density,
  };
  const darkness = computeDarkness(luminance, WORK_SIZE_PX, options);
  const drawing = imageToLineart(darkness, WORK_SIZE_PX, options);
  return drawingToSvg(drawing);
}

/** Decode an uploaded file into an <img> once it's ready to draw. */
export function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode "${file.name}" — is it a valid image?`));
    };
    image.src = url;
  });
}
