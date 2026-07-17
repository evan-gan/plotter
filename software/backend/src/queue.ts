// The drawing queue: submissions from the frontend (SVG or G-code) and picks
// from the gallery. Job metadata persists in DATA_DIR/queue.json; each job's
// G-code + preview SVG live beside it in DATA_DIR/jobs/.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { JsonStore } from "./db";

export type JobStatus = "queued" | "plotting" | "paused" | "done" | "aborted" | "failed";

/**
 * Paper-placement metadata for the admin overlay + scale control. Mirrors
 * `PaperLayoutResult` from plotter-utils minus the geometry. Null for jobs that
 * weren't placed on paper (e.g. authored G-code streamed as-is).
 */
export interface LayoutInfo {
  orientation: "portrait" | "landscape";
  paperWidthMm: number;
  paperHeightMm: number;
  paddingMm: number;
  /** Padded printable area (paper minus 2× padding), mm. */
  drawableWidthMm: number;
  drawableHeightMm: number;
  contentWidthMm: number;
  contentHeightMm: number;
  /** Top-left of the drawing in the operator's view (mm from page top-left). */
  positionXMm: number;
  positionYMm: number;
  appliedScale: number;
  maxFitScale: number;
  /** Fraction of the max fit currently used, in (0,1]. Drives the scale slider. */
  fillFraction: number;
  mirrorX: boolean;
  /** True when the drawing extends past the padded printable area. */
  overflows: boolean;
}

/** The admin's persisted placement overrides, re-applied on any regeneration. */
export interface LayoutRequestInfo {
  fillFraction: number | null;
  orientation: "portrait" | "landscape" | null;
  positionXMm: number | null;
  positionYMm: number | null;
}

export interface Job {
  id: string;
  name: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  source: "svg-upload" | "gcode-upload" | "gallery";
  etaSeconds: number | null;
  lineCount: number;
  /** Optimizer stats (pen-up mm before/after, lifts) when it ran. */
  stats: Record<string, number> | null;
  /** Paper placement + scale info; null when the job isn't paper-placed. */
  layout: LayoutInfo | null;
  /** Admin's placement overrides, re-applied when the job is regenerated. */
  layoutRequest: LayoutRequestInfo | null;
  /** Kind of the retained source, so a rescale can regenerate. Null = no source kept. */
  sourceKind: "svg" | "gcode" | null;
  /** Whether the source is (re)optimized when regenerating. */
  optimize: boolean;
  error: string | null;
}

interface QueueDocument {
  jobs: Job[];
}

export class QueueService {
  private store: JsonStore<QueueDocument>;
  private document: QueueDocument;
  private jobsDir: string;
  private onChange: () => void;

  constructor(dataDir: string, onChange: () => void) {
    this.store = new JsonStore<QueueDocument>(path.join(dataDir, "queue.json"), { jobs: [] });
    this.document = this.store.load();
    this.jobsDir = path.join(dataDir, "jobs");
    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.onChange = onChange;
    this.recoverInterrupted();
  }

  /** Jobs stuck "plotting"/"paused" after a crash/restart become failed. */
  private recoverInterrupted(): void {
    for (const job of this.document.jobs) {
      if (job.status === "plotting" || job.status === "paused") {
        job.status = "failed";
        job.error = "Server restarted mid-plot.";
        job.finishedAt = new Date().toISOString();
      }
    }
    this.store.save(this.document);
  }

  private persist(): void {
    this.store.save(this.document);
    this.onChange();
  }

  list(): Job[] {
    return this.document.jobs;
  }

  get(jobId: string): Job | undefined {
    return this.document.jobs.find((job) => job.id === jobId);
  }

  /** Queued jobs in plot order. */
  pending(): Job[] {
    return this.document.jobs.filter((job) => job.status === "queued");
  }

  gcodePath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.gcode`);
  }

  previewPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.svg`);
  }

  /** Retained original source (SVG/G-code) so a job can be rescaled later. */
  sourcePath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.source`);
  }

  /** Read a job's retained source, or null if none was kept. */
  readSource(jobId: string): string | null {
    try {
      return fs.readFileSync(this.sourcePath(jobId), "utf8");
    } catch {
      return null;
    }
  }

  add(input: {
    name: string;
    source: Job["source"];
    gcode: string;
    previewSvg: string;
    etaSeconds: number | null;
    stats: Record<string, number> | null;
    layout?: LayoutInfo | null;
    layoutRequest?: LayoutRequestInfo | null;
    sourceText?: string | null;
    sourceKind?: Job["sourceKind"];
    optimize?: boolean;
  }): Job {
    const job: Job = {
      id: crypto.randomBytes(6).toString("hex"),
      name: sanitizeName(input.name),
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      source: input.source,
      etaSeconds: input.etaSeconds,
      lineCount: input.gcode.split("\n").filter((line) => line.trim() && !line.trim().startsWith(";")).length,
      stats: input.stats,
      layout: input.layout ?? null,
      layoutRequest: input.layoutRequest ?? null,
      sourceKind: input.sourceKind ?? null,
      optimize: input.optimize ?? true,
      error: null,
    };
    fs.writeFileSync(this.gcodePath(job.id), input.gcode);
    fs.writeFileSync(this.previewPath(job.id), input.previewSvg);
    // Keep the source only when it can be re-prepared (so the admin can rescale).
    if (input.sourceText != null && input.sourceKind) {
      fs.writeFileSync(this.sourcePath(job.id), input.sourceText);
    }
    this.document.jobs.push(job);
    this.persist();
    return job;
  }

  /** Overwrite a job's generated files (used when regenerating at a new scale). */
  writeGenerated(jobId: string, gcode: string, previewSvg: string): void {
    fs.writeFileSync(this.gcodePath(jobId), gcode);
    fs.writeFileSync(this.previewPath(jobId), previewSvg);
  }

  /** Reorder the *queued* jobs to match `orderedIds` (others keep position). */
  reorder(orderedIds: string[]): void {
    const queued = this.pending();
    const byId = new Map(queued.map((job) => [job.id, job]));
    if (orderedIds.length !== queued.length || orderedIds.some((id) => !byId.has(id))) {
      throw new Error("Reorder list must contain exactly the currently-queued job ids.");
    }
    const reordered = orderedIds.map((id) => byId.get(id) as Job);
    let cursor = 0;
    this.document.jobs = this.document.jobs.map((job) => (job.status === "queued" ? reordered[cursor++] : job));
    this.persist();
  }

  remove(jobId: string): void {
    const job = this.get(jobId);
    if (!job) throw new Error(`No job ${jobId}.`);
    if (job.status === "plotting" || job.status === "paused") {
      throw new Error("Can't delete a job that is currently plotting — abort it first.");
    }
    this.document.jobs = this.document.jobs.filter((entry) => entry.id !== jobId);
    for (const file of [this.gcodePath(jobId), this.previewPath(jobId), this.sourcePath(jobId)]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
    this.persist();
  }

  update(jobId: string, patch: Partial<Job>): Job {
    const job = this.get(jobId);
    if (!job) throw new Error(`No job ${jobId}.`);
    Object.assign(job, patch);
    this.persist();
    return job;
  }
}

/** Keep names displayable and filesystem/HTML-safe. */
export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[<>&"'\\/\x00-\x1f]/g, "").trim().slice(0, 80);
  return cleaned || "untitled";
}
