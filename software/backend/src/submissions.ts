// Submission pipeline shared by /api/estimate (preview only) and /api/submit
// (enqueue): SVG or G-code text in → optimized + paper-placed G-code + preview
// + ETA out. Placement (orientation/scale/mirror/bottom-right anchor) is applied
// so plots are easy to align by hand; the admin can rescale a queued job later.

import { PreparePlotOptions } from "plotter-utils";
import { BackendConfig, paperLayoutOptions, LayoutRequest } from "./config";
import { EtaService } from "./eta";
import { QueueService, Job, LayoutInfo, LayoutRequestInfo } from "./queue";
import { PipelineRunner, InlinePipeline, PrepareResult, EtaResult } from "./pipeline-pool";

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
  eta: EtaResult;
  stats: Record<string, number> | null;
  layout: LayoutInfo | null;
}

interface PreparedSubmission {
  result: PrepareResult;
  sourceKind: Job["sourceKind"];
  sourceText: string | null;
  optimize: boolean;
}

export class SubmissionService {
  private config: BackendConfig;
  private eta: EtaService;
  private queue: QueueService;
  private pipeline: PipelineRunner;

  constructor(
    config: BackendConfig,
    eta: EtaService,
    queue: QueueService,
    pipeline: PipelineRunner = new InlinePipeline()
  ) {
    this.config = config;
    this.eta = eta;
    this.queue = queue;
    this.pipeline = pipeline;
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
    // Read live board settings once (serial I/O); the heavy optimize + estimate
    // then run on the pipeline (a worker thread in production).
    const settings = await this.eta.liveSettings();
    const feedMmMin = await this.drawFeedMmMin();
    const paper = paperLayoutOptions(this.config, input.layout);
    if (typeof input.svgText === "string" && input.svgText.trim()) {
      const options: PreparePlotOptions = {
        optimize,
        // Parse at the work-area size; layout then fits it to the paper.
        svg: { fitWidthMm: this.config.workWidthMm, fitHeightMm: this.config.workHeightMm },
        gcode: { feedMmMin },
        paper,
      };
      const result = await this.pipeline.prepare({ kind: "svg", source: input.svgText, options, settings });
      return { result, sourceKind: "svg", sourceText: input.svgText, optimize };
    }
    if (typeof input.gcodeText === "string" && input.gcodeText.trim()) {
      // optimize=false streams the file byte-for-byte (author's feeds + layout
      // preserved, no paper placement); optimize=true re-generates + places it.
      const options: PreparePlotOptions = {
        optimize,
        gcode: { feedMmMin },
        ...(optimize ? { paper } : {}),
      };
      const result = await this.pipeline.prepare({ kind: "gcode", source: input.gcodeText, options, settings });
      // Only keep the source when it can be regenerated (placed) at a new scale.
      return { result, sourceKind: "gcode", sourceText: optimize ? input.gcodeText : null, optimize };
    }
    throw new Error("Provide svgText or gcodeText.");
  }

  private toPreview(result: PrepareResult): SubmissionPreview {
    return {
      previewSvg: result.previewSvg,
      gcodeLineCount: result.gcode.split("\n").length,
      eta: result.eta,
      stats: result.stats,
      layout: result.layout,
    };
  }

  /** Estimate without touching the queue (drives the submit-page preview). */
  async estimate(input: SubmissionInput): Promise<SubmissionPreview> {
    const { result } = await this.prepare(input);
    return this.toPreview(result);
  }

  /** Full submission: prepare, estimate, persist as a queued job. */
  async submit(
    input: SubmissionInput, source?: Job["source"]
  ): Promise<{ job: Job; preview: SubmissionPreview }> {
    const { result, sourceKind, sourceText, optimize } = await this.prepare(input);
    const job = this.queue.add({
      name: input.name ?? "untitled",
      source: source ?? (input.svgText ? "svg-upload" : "gcode-upload"),
      gcode: result.gcode,
      previewSvg: result.previewSvg,
      etaSeconds: result.eta.seconds,
      stats: result.stats,
      layout: result.layout,
      layoutRequest: toLayoutRequestInfo(input.layout),
      sourceText,
      sourceKind,
      optimize,
    });
    return { job, preview: this.toPreview(result) };
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
    const { result } = await this.prepare(input);
    this.queue.writeGenerated(jobId, result.gcode, result.previewSvg);
    return this.queue.update(jobId, {
      etaSeconds: result.eta.seconds,
      stats: result.stats,
      layout: result.layout,
      layoutRequest: merged,
      lineCount: result.gcode.split("\n").filter((line) => line.trim() && !line.trim().startsWith(";")).length,
    });
  }
}
