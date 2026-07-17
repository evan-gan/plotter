// Worker-thread entry point for the plotting pipeline. Receives a prepare or
// estimate task, runs the (CPU-heavy) synchronous work off the main event
// loop, and posts the slim result back. See pipeline-pool.ts for the host side.

import { parentPort } from "worker_threads";
import { runPrepare, runEstimate, PrepareTask, EstimateTask } from "./pipeline-compute";

type Incoming =
  | { id: number; type: "prepare"; task: PrepareTask }
  | { id: number; type: "estimate"; task: EstimateTask };

if (parentPort) {
  parentPort.on("message", (message: Incoming) => {
    try {
      const result = message.type === "prepare" ? runPrepare(message.task) : runEstimate(message.task);
      parentPort!.postMessage({ id: message.id, ok: true, result });
    } catch (error) {
      parentPort!.postMessage({ id: message.id, ok: false, error: (error as Error).message });
    }
  });
}
