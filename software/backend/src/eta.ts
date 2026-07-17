// ETA wrapper: firmware/tools' physics engine + host-side calibration knobs.
// Reads live `$$` settings when a board is reachable so estimates track the
// current tuning; falls back to firmware compile-time defaults offline.

import { SerialManager } from "./serial-manager";
import { PipelineRunner, InlinePipeline, EtaResult } from "./pipeline-pool";

export class EtaService {
  private serial: SerialManager;
  private pipeline: PipelineRunner;
  private cachedSettings: Record<string, number> | null = null;
  private cachedAt = 0;
  private static readonly SETTINGS_TTL_MS = 60_000;

  constructor(serial: SerialManager, pipeline: PipelineRunner = new InlinePipeline()) {
    this.serial = serial;
    this.pipeline = pipeline;
  }

  /** Live `$$` if a board is connected (cached briefly), else null. */
  async liveSettings(): Promise<Record<string, number> | null> {
    if (this.cachedSettings && Date.now() - this.cachedAt < EtaService.SETTINGS_TTL_MS) {
      return this.cachedSettings;
    }
    if (!this.serial.isConnected) return null; // never force a connect just for an ETA
    try {
      const connection = await this.serial.ensure();
      this.cachedSettings = await connection.settings();
      this.cachedAt = Date.now();
      return this.cachedSettings;
    } catch {
      return null;
    }
  }

  invalidateSettingsCache(): void {
    this.cachedSettings = null;
  }

  /**
   * The board's tuned max feedrate (`$110`, mm/min) when a board is reachable,
   * else null. Used to draw at the speed the machine was actually tuned for
   * instead of the generator's compile-time default.
   */
  async liveMaxFeedMmMin(): Promise<number | null> {
    const settings = await this.liveSettings();
    const feed = settings?.["$110"];
    return typeof feed === "number" && feed > 0 ? feed : null;
  }

  /**
   * Estimate run time for a G-code program (seconds + full breakdown). Reads
   * live board settings here (serial I/O) and hands the CPU-heavy physics pass
   * to the pipeline, which offloads it from the main event loop in production.
   */
  async estimate(gcodeText: string): Promise<EtaResult> {
    const settings = await this.liveSettings();
    return this.pipeline.estimate({ gcode: gcodeText, settings });
  }
}

export type { EtaResult };
