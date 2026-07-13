// Gallery: the repo's drawings/ folder (populated via GitHub PRs) exposed
// with previews + computed ETAs. Entries are (re)processed lazily and cached
// by file mtime so a Pi doesn't re-optimize every request.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { prepareSvgPlot, prepareGcodePlot, PreparedPlot } from "plotter-utils";
import { JsonStore } from "./db";
import { EtaService } from "./eta";
import { BackendConfig } from "./config";

export interface GalleryEntry {
  id: string;
  name: string;
  fileName: string;
  kind: "svg" | "gcode";
  etaSeconds: number | null;
  penUpSavedMm: number | null;
  modifiedAt: number;
  error: string | null;
}

interface GalleryCache {
  entries: Record<string, GalleryEntry>;
}

export class GalleryService {
  private config: BackendConfig;
  private eta: EtaService;
  private cacheStore: JsonStore<GalleryCache>;
  private cache: GalleryCache;
  private previewDir: string;

  constructor(config: BackendConfig, eta: EtaService) {
    this.config = config;
    this.eta = eta;
    this.cacheStore = new JsonStore<GalleryCache>(path.join(config.dataDir, "gallery-cache.json"), { entries: {} });
    this.cache = this.cacheStore.load();
    this.previewDir = path.join(config.dataDir, "gallery-previews");
    fs.mkdirSync(this.previewDir, { recursive: true });
    fs.mkdirSync(config.galleryDir, { recursive: true });
  }

  /**
   * Drop all cached entries so the next `list()` reprocesses every file. Called
   * after the board is retuned so gallery gcode regenerates at the new draw
   * feed (previews + ETAs are re-derived too).
   */
  invalidateCache(): void {
    this.cache.entries = {};
    this.cacheStore.save(this.cache);
  }

  /**
   * Force a full reprocess of every drawing: clears the mtime cache and
   * eagerly regenerates previews + G-code. Called at server startup so gallery
   * G-code always reflects the *current* optimizer/generator code (e.g. after a
   * deploy that changed the path optimizer), not a stale cached result from an
   * older algorithm version.
   */
  async refreshAll(): Promise<GalleryEntry[]> {
    this.invalidateCache();
    return this.list();
  }

  /** List entries, processing new/changed files as needed. */
  async list(): Promise<GalleryEntry[]> {
    const files = fs
      .readdirSync(this.config.galleryDir)
      .filter((name) => /\.(svg|gcode|nc)$/i.test(name))
      .sort();
    const seen = new Set<string>();
    const entries: GalleryEntry[] = [];
    for (const fileName of files) {
      const id = idFor(fileName);
      seen.add(id);
      const fullPath = path.join(this.config.galleryDir, fileName);
      const modifiedAt = fs.statSync(fullPath).mtimeMs;
      const cached = this.cache.entries[id];
      entries.push(
        cached && cached.modifiedAt === modifiedAt ? cached : await this.process(id, fileName, fullPath, modifiedAt)
      );
    }
    // Drop cache entries whose files were removed from the folder.
    for (const id of Object.keys(this.cache.entries)) {
      if (!seen.has(id)) delete this.cache.entries[id];
    }
    this.cacheStore.save(this.cache);
    return entries;
  }

  private async process(id: string, fileName: string, fullPath: string, modifiedAt: number): Promise<GalleryEntry> {
    const kind: GalleryEntry["kind"] = /\.svg$/i.test(fileName) ? "svg" : "gcode";
    const entry: GalleryEntry = {
      id,
      name: path.basename(fileName).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
      fileName,
      kind,
      etaSeconds: null,
      penUpSavedMm: null,
      modifiedAt,
      error: null,
    };
    try {
      const prepared = await this.prepare(fullPath, kind);
      fs.writeFileSync(this.previewPath(id), prepared.previewSvg);
      const breakdown = await this.eta.estimate(prepared.gcode);
      entry.etaSeconds = breakdown.seconds;
      entry.penUpSavedMm = prepared.stats ? prepared.stats.penUpBeforeMm - prepared.stats.penUpAfterMm : null;
    } catch (error) {
      entry.error = (error as Error).message;
    }
    this.cache.entries[id] = entry;
    return entry;
  }

  private async prepare(fullPath: string, kind: "svg" | "gcode"): Promise<PreparedPlot> {
    const source = fs.readFileSync(fullPath, "utf8");
    if (kind === "svg") {
      // Draw at the board's tuned max feed ($110), matching the submit path;
      // fall back to the configured default when no board is reachable.
      const feedMmMin = (await this.eta.liveMaxFeedMmMin()) ?? this.config.drawFeedMmMin;
      return prepareSvgPlot(source, {
        svg: { fitWidthMm: this.config.workWidthMm, fitHeightMm: this.config.workHeightMm },
        gcode: { feedMmMin },
      });
    }
    // Pre-made G-code is trusted as-is (no re-optimization: the author's
    // feeds/order stay intact); we only derive the preview.
    return prepareGcodePlot(source, { optimize: false });
  }

  get(id: string): GalleryEntry | undefined {
    return this.cache.entries[id];
  }

  /**
   * Read a gallery entry's *original* source file (the SVG/G-code in
   * `drawings/`), so a pick can be re-prepared from scratch at enqueue time —
   * exactly like a user upload — rather than served from a cached result. This
   * is what lets a gallery pick pick up the board's current tuning + the latest
   * optimizer. Returns null for an unknown id.
   */
  readSource(id: string): { name: string; kind: GalleryEntry["kind"]; source: string } | null {
    const entry = this.cache.entries[id];
    if (!entry) return null;
    const fullPath = path.join(this.config.galleryDir, entry.fileName);
    return { name: entry.name, kind: entry.kind, source: fs.readFileSync(fullPath, "utf8") };
  }

  previewPath(id: string): string {
    return path.join(this.previewDir, `${id}.svg`);
  }
}

function idFor(fileName: string): string {
  return crypto.createHash("sha1").update(fileName).digest("hex").slice(0, 12);
}
