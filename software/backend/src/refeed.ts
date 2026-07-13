// Refeed: after the board is retuned (or ETA-calibrated, or a motion setting is
// changed by hand), already-generated jobs still carry the draw feedrate that
// was current when they were created. This service rewrites queued jobs — and
// refreshes the gallery — to the board's *current* tuned max feed (`$110`) so
// plots run at the speed the machine is actually tuned for, not the speed they
// happened to be generated at. Authored G-code is never touched.

import fs from "fs";
import { retargetDrawFeed } from "plotter-utils";
import { EtaService } from "./eta";
import { QueueService } from "./queue";
import { GalleryService } from "./gallery";
import { EventBus } from "./events";

export class PlotRefeedService {
  private eta: EtaService;
  private queue: QueueService;
  private gallery: GalleryService;
  private bus: EventBus;

  constructor(eta: EtaService, queue: QueueService, gallery: GalleryService, bus: EventBus) {
    this.eta = eta;
    this.queue = queue;
    this.gallery = gallery;
    this.bus = bus;
  }

  /**
   * Rewrite every queued job's draw feed to the board's tuned `$110` and drop
   * the gallery cache so it regenerates at the new feed. No-op when no board is
   * reachable (we must not guess a feed and slow jobs down). Safe to call after
   * any event that may have changed the board's motion settings.
   *
   * @returns How many queued jobs were rewritten and the feed used, or null
   *          when skipped because no tuned feed was available.
   */
  async refresh(): Promise<{ updated: number; feedMmMin: number } | null> {
    // Tuning just changed the board, so the 60 s settings cache is stale.
    this.eta.invalidateSettingsCache();
    const feedMmMin = await this.eta.liveMaxFeedMmMin();
    if (feedMmMin == null) {
      this.bus.log("Refeed skipped: no board reachable to read the tuned feed ($110).");
      return null;
    }

    // Gallery gcode is regenerated lazily on the next list() using live $110.
    this.gallery.invalidateCache();

    let updated = 0;
    for (const job of this.queue.list()) {
      if (job.status !== "queued") continue; // never rewrite a plot in flight
      if (await this.refeedJob(job.id, feedMmMin)) updated++;
    }

    this.bus.log(
      `Refed ${updated} queued job(s) + gallery to the tuned feed (${Math.round(feedMmMin)} mm/min).`
    );
    this.bus.broadcast({ type: "queueChanged" });
    return { updated, feedMmMin };
  }

  /** Rewrite one job's feed + refresh its ETA. Returns false if not our gcode. */
  private async refeedJob(jobId: string, feedMmMin: number): Promise<boolean> {
    const gcodePath = this.queue.gcodePath(jobId);
    let gcode: string;
    try {
      gcode = fs.readFileSync(gcodePath, "utf8");
    } catch (error) {
      this.bus.log(`Refeed skipped job ${jobId}: ${(error as Error).message}`);
      return false;
    }

    const rewritten = retargetDrawFeed(gcode, feedMmMin);
    if (rewritten === null || rewritten === gcode) return false; // authored gcode or already at feed

    fs.writeFileSync(gcodePath, rewritten);
    const eta = await this.eta.estimate(rewritten);
    this.queue.update(jobId, { etaSeconds: eta.seconds });
    return true;
  }
}
