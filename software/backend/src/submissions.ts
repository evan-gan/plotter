// Submission pipeline shared by /api/estimate (preview only) and /api/submit
// (enqueue): SVG or G-code text in → optimized + paper-placed G-code + preview
// + ETA out. Placement (orientation/scale/mirror/bottom-right anchor) is applied
// so plots are easy to align by hand; the admin can rescale a queued job later.

import { prepareSvgPlot, prepareGcodePlot, PreparedPlot, PaperLayoutResult } from "plotter-utils";
import { BackendConfig, paperLayoutOptions, LayoutRequest } from "./config";
import { EtaService } from "./eta";
import { QueueService, Job, LayoutInfo, LayoutRequestInfo } from "./queue";
import { EtaBreakdown } from "./firmware-bridge";

export interface SubmissionInput {
  name?: string;
  svgText?: string;
  gcodeText?: string;
  /** Default true. For G-code, false streams the file exactly as written. */
  optimize?: boolean;
  /** Admin placement overrides (scale/orientation/position); omit for auto. */
  layout?: LayoutRequest | null;
}

/** Normalise a placement request into the fully-nulled shape stored on a job. */
function toLayoutRequestInfo(request?: LayoutRequest | null): LayoutRequestInfo {
  return {
    fillFraction: request?.fillFraction ?? null,
    orientation: request?.orientation ?? null,
    positionXMm: request?.positionXMm ?? null,
    positionYMm: request?.positionYMm ?? null,
  };
}

export interface SubmissionPreview {
  previewSvg: string;
  gcodeLineCount: number;
  eta: EtaBreakdown & { calibrated: boolean; liveSettings: boolean };
  stats: Record<string, number> | null;
  layout: LayoutInfo | null;
}

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

interface PreparedSubmission {
  prepared: PreparedPlot;
  sourceKind: Job["sourceKind"];
  sourceText: string | null;
  optimize: boolean;
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

  private async prepare(input: SubmissionInput): Promise<PreparedSubmission> {
    const optimize = input.optimize !== false;
    const feedMmMin = await this.drawFeedMmMin();
    const paper = paperLayoutOptions(this.config, input.layout);
    if (typeof input.svgText === "string" && input.svgText.trim()) {
      const prepared = prepareSvgPlot(input.svgText, {
        optimize,
        // Parse at the work-area size; layout then fits it to the paper.
        svg: { fitWidthMm: this.config.workWidthMm, fitHeightMm: this.config.workHeightMm },
        gcode: { feedMmMin },
        paper,
      });
      return { prepared, sourceKind: "svg", sourceText: input.svgText, optimize };
    }
    if (typeof input.gcodeText === "string" && input.gcodeText.trim()) {
      // optimize=false streams the file byte-for-byte (author's feeds + layout
      // preserved, no paper placement); optimize=true re-generates + places it.
      const prepared = prepareGcodePlot(input.gcodeText, {
        optimize,
        gcode: { feedMmMin },
        ...(optimize ? { paper } : {}),
      });
      // Only keep the source when it can be regenerated (placed) at a new scale.
      return { prepared, sourceKind: "gcode", sourceText: optimize ? input.gcodeText : null, optimize };
    }
    throw new Error("Provide svgText or gcodeText.");
  }

  private toPreview(prepared: PreparedPlot, eta: SubmissionPreview["eta"]): SubmissionPreview {
    return {
      previewSvg: prepared.previewSvg,
      gcodeLineCount: prepared.gcode.split("\n").length,
      eta,
      stats: (prepared.stats as Record<string, number> | null) ?? null,
      layout: toLayoutInfo(prepared.layout),
    };
  }

  /** Estimate without touching the queue (drives the submit-page preview). */
  async estimate(input: SubmissionInput): Promise<SubmissionPreview> {
    const { prepared } = await this.prepare(input);
    const eta = await this.eta.estimate(prepared.gcode);
    return this.toPreview(prepared, eta);
  }

  /** Full submission: prepare, estimate, persist as a queued job. */
  async submit(
    input: SubmissionInput, source?: Job["source"]
  ): Promise<{ job: Job; preview: SubmissionPreview }> {
    const { prepared, sourceKind, sourceText, optimize } = await this.prepare(input);
    const eta = await this.eta.estimate(prepared.gcode);
    const layout = toLayoutInfo(prepared.layout);
    const job = this.queue.add({
      name: input.name ?? "untitled",
      source: source ?? (input.svgText ? "svg-upload" : "gcode-upload"),
      gcode: prepared.gcode,
      previewSvg: prepared.previewSvg,
      etaSeconds: eta.seconds,
      stats: (prepared.stats as Record<string, number> | null) ?? null,
      layout,
      layoutRequest: toLayoutRequestInfo(input.layout),
      sourceText,
      sourceKind,
      optimize,
    });
    return { job, preview: this.toPreview(prepared, eta) };
  }

  /**
   * Re-place a queued job on the paper — change its scale, orientation, and/or
   * position — regenerating its G-code, preview, ETA, and layout in place.
   * Overrides are merged onto the job's existing placement, so changing only the
   * position keeps the current scale/orientation. Needs the job's retained source.
   *
   * @param jobId  The queued job to re-place.
   * @param patch  Fields to change; a field set to `null` resets to auto.
   *               An omitted field keeps the job's current value.
   * @returns The updated job.
   * @throws When the job is unknown, has no retained source, or isn't queued.
   */
  async setLayout(jobId: string, patch: LayoutRequest): Promise<Job> {
    const job = this.queue.get(jobId);
    if (!job) throw new Error(`No job ${jobId}.`);
    if (job.status !== "queued") throw new Error("Only queued jobs can be re-placed.");
    const sourceText = this.queue.readSource(jobId);
    if (!sourceText || !job.sourceKind) {
      throw new Error("This job can't be re-placed — its original source wasn't retained.");
    }
    // Merge the patch onto the stored request: keep fields the patch omits.
    const merged: LayoutRequestInfo = { ...toLayoutRequestInfo(job.layoutRequest), ...patch };
    const input: SubmissionInput =
      job.sourceKind === "svg"
        ? { name: job.name, svgText: sourceText, optimize: job.optimize, layout: merged }
        : { name: job.name, gcodeText: sourceText, optimize: job.optimize, layout: merged };
    const { prepared } = await this.prepare(input);
    const eta = await this.eta.estimate(prepared.gcode);
    this.queue.writeGenerated(jobId, prepared.gcode, prepared.previewSvg);
    return this.queue.update(jobId, {
      etaSeconds: eta.seconds,
      stats: (prepared.stats as Record<string, number> | null) ?? null,
      layout: toLayoutInfo(prepared.layout),
      layoutRequest: merged,
      lineCount: prepared.gcode.split("\n").filter((line) => line.trim() && !line.trim().startsWith(";")).length,
    });
  }
}
