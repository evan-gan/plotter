// Host side of the plotting pipeline. Two implementations of one interface:
//
//   InlinePipeline  — runs the work synchronously on the calling thread.
//                     Used by tests and as a zero-config fallback.
//   WorkerPipeline  — offloads the work to a worker thread so it never blocks
//                     the main event loop. Used in production.
//
// Why this matters: the optimizer + G-code generation for a large drawing
// (e.g. a photo stipple with thousands of polylines) can run for several
// seconds. On Node's single event loop that would stall the plot runner's
// serial ok/error flow control AND freeze the realtime controls (pause /
// abort / jog) — the exact "it stops plotting and the buttons stop working"
// symptom. Moving it to a worker keeps the loop free for I/O.

import { Worker } from "worker_threads";
import path from "path";
import { runPrepare, runEstimate, PrepareTask, EstimateTask, PrepareResult, EtaResult } from "./pipeline-compute";

// Re-export so callers can depend on the pipeline module alone.
export type { PrepareTask, EstimateTask, PrepareResult, EtaResult } from "./pipeline-compute";

export interface PipelineRunner {
  prepare(task: PrepareTask): Promise<PrepareResult>;
  estimate(task: EstimateTask): Promise<EtaResult>;
  destroy(): void;
}

/** Synchronous, in-process pipeline — simple and dependency-free (tests). */
export class InlinePipeline implements PipelineRunner {
  async prepare(task: PrepareTask): Promise<PrepareResult> {
    return runPrepare(task);
  }
  async estimate(task: EstimateTask): Promise<EtaResult> {
    return runEstimate(task);
  }
  destroy(): void {
    /* nothing to tear down */
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Runs the pipeline on a single worker thread with a FIFO queue. One operator
 * uses this plotter, so throughput isn't the goal — keeping the main event
 * loop responsive during a plot is. Tasks that arrive while the worker is busy
 * queue up (far better than blocking the loop). The worker is respawned lazily
 * if it ever crashes, and in-flight tasks are rejected with a clear message.
 */
export class WorkerPipeline implements PipelineRunner {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, "pipeline-worker.js"));
    worker.on("message", (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error ?? "Pipeline worker reported an unknown error."));
    });
    const failAll = (reason: string) => {
      this.worker = null;
      for (const [id, entry] of this.pending) {
        this.pending.delete(id);
        entry.reject(new Error(`Pipeline worker ${reason}.`));
      }
    };
    worker.on("error", (error) => failAll(`crashed: ${error.message}`));
    worker.on("exit", (code) => {
      if (code !== 0) failAll(`exited unexpectedly (code ${code})`);
    });
    // Don't let a pending pipeline task keep the process alive on shutdown.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private dispatch<T>(type: "prepare" | "estimate", task: unknown): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, type, task });
    });
  }

  prepare(task: PrepareTask): Promise<PrepareResult> {
    return this.dispatch<PrepareResult>("prepare", task);
  }

  estimate(task: EstimateTask): Promise<EtaResult> {
    return this.dispatch<EtaResult>("estimate", task);
  }

  destroy(): void {
    if (this.worker) {
      void this.worker.terminate();
      this.worker = null;
    }
  }
}
