// The CPU-heavy plotting work, factored into pure functions so it can run
// either inline (tests/fallback) or on a worker thread (production). This is
// the code that must NOT block the main event loop while a plot streams:
// the path optimizer + G-code generation (runPrepare) and the ETA physics
// pass (runEstimate). Everything here is synchronous and serial-free — the
// caller reads live board settings and passes them in.

import { prepareSvgPlot, prepareGcodePlot, PreparePlotOptions } from "plotter-utils";
import { etaEngine, gcodeParser, calibrationStore, EtaBreakdown } from "./firmware-bridge";
import { toLayoutInfo } from "./layout-info";
import { LayoutInfo } from "./queue";

export type EtaResult = EtaBreakdown & { calibrated: boolean; liveSettings: boolean };

export interface PrepareTask {
  kind: "svg" | "gcode";
  source: string;
  options: PreparePlotOptions;
  /** Live `$$` settings for the ETA (null when no board is reachable). */
  settings: Record<string, number> | null;
}

export interface EstimateTask {
  gcode: string;
  settings: Record<string, number> | null;
}

export interface PrepareResult {
  gcode: string;
  previewSvg: string;
  stats: Record<string, number> | null;
  layout: LayoutInfo | null;
  eta: EtaResult;
}

/** Estimate run time for a G-code program using live settings + host calibration. */
export function runEstimate(task: EstimateTask): EtaResult {
  const calibration = calibrationStore.loadCalibration();
  const config = etaEngine.configFromSettings(task.settings, calibration ?? {});
  const primitives = gcodeParser.parseGcode(task.gcode, config.arcToleranceMm);
  const breakdown = etaEngine.estimateEta(primitives, config);
  return { ...breakdown, calibrated: calibration !== null, liveSettings: task.settings !== null };
}

/** Full prepare: optimize + place + generate G-code/preview, then estimate. */
export function runPrepare(task: PrepareTask): PrepareResult {
  const prepared =
    task.kind === "svg" ? prepareSvgPlot(task.source, task.options) : prepareGcodePlot(task.source, task.options);
  const eta = runEstimate({ gcode: prepared.gcode, settings: task.settings });
  return {
    gcode: prepared.gcode,
    previewSvg: prepared.previewSvg,
    stats: (prepared.stats as Record<string, number> | null) ?? null,
    layout: toLayoutInfo(prepared.layout),
    eta,
  };
}
