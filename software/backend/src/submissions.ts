// Submission pipeline shared by /api/estimate (preview only) and /api/submit
// (enqueue): SVG or G-code text in → optimized G-code + preview + ETA out.

import { prepareSvgPlot, prepareGcodePlot, PreparedPlot } from "plotter-utils";
import { BackendConfig } from "./config";
import { EtaService } from "./eta";
import { QueueService, Job } from "./queue";
import { EtaBreakdown } from "./firmware-bridge";

export interface SubmissionInput {
  name?: string;
  svgText?: string;
  gcodeText?: string;
  /** Default true. For G-code, false streams the file exactly as written. */
  optimize?: boolean;
}

export interface SubmissionPreview {
  previewSvg: string;
  gcodeLineCount: number;
  eta: EtaBreakdown & { calibrated: boolean; liveSettings: boolean };
  stats: Record<string, number> | null;
}

export class SubmissionService {
  private config: BackendConfig;
  private eta: EtaService;
  private queue: QueueService;

  constructor(config: BackendConfig, eta: EtaService, queue: QueueService) {
    this.config = config;
    this.eta = eta;
    this.queue = queue;
  }

  /**
   * Draw at the board's tuned max feed (`$110`) so plots run at the speed the
   * machine was calibrated for; fall back to the configured default offline.
   */
  private async drawFeedMmMin(): Promise<number> {
    const liveFeed = await this.eta.liveMaxFeedMmMin();
    return liveFeed ?? this.config.drawFeedMmMin;
  }

  private async prepare(input: SubmissionInput): Promise<PreparedPlot> {
    const optimize = input.optimize !== false;
    const feedMmMin = await this.drawFeedMmMin();
    if (typeof input.svgText === "string" && input.svgText.trim()) {
      return prepareSvgPlot(input.svgText, {
        optimize,
        svg: { fitWidthMm: this.config.workWidthMm, fitHeightMm: this.config.workHeightMm },
        gcode: { feedMmMin },
      });
    }
    if (typeof input.gcodeText === "string" && input.gcodeText.trim()) {
      // optimize=false streams the file byte-for-byte, so the author's own
      // feeds are preserved; feedMmMin only applies when we regenerate.
      return prepareGcodePlot(input.gcodeText, { optimize, gcode: { feedMmMin } });
    }
    throw new Error("Provide svgText or gcodeText.");
  }

  /** Estimate without touching the queue (drives the submit-page preview). */
  async estimate(input: SubmissionInput): Promise<SubmissionPreview> {
    const prepared = await this.prepare(input);
    const eta = await this.eta.estimate(prepared.gcode);
    return {
      previewSvg: prepared.previewSvg,
      gcodeLineCount: prepared.gcode.split("\n").length,
      eta,
      stats: (prepared.stats as Record<string, number> | null) ?? null,
    };
  }

  /** Full submission: prepare, estimate, persist as a queued job. */
  async submit(
    input: SubmissionInput, source?: Job["source"]
  ): Promise<{ job: Job; preview: SubmissionPreview }> {
    const prepared = await this.prepare(input);
    const eta = await this.eta.estimate(prepared.gcode);
    const job = this.queue.add({
      name: input.name ?? "untitled",
      source: source ?? (input.svgText ? "svg-upload" : "gcode-upload"),
      gcode: prepared.gcode,
      previewSvg: prepared.previewSvg,
      etaSeconds: eta.seconds,
      stats: (prepared.stats as Record<string, number> | null) ?? null,
    });
    return {
      job,
      preview: {
        previewSvg: prepared.previewSvg,
        gcodeLineCount: prepared.gcode.split("\n").length,
        eta,
        stats: (prepared.stats as Record<string, number> | null) ?? null,
      },
    };
  }
}
