// All backend configuration comes from environment variables so nothing
// machine-specific is hardcoded (see software/backend/README.md).

import path from "path";
import fs from "fs";

export interface BackendConfig {
  httpPort: number;
  /** Bind address. 0.0.0.0 on the Pi so the LAN can reach it. */
  host: string;
  /** Admin password — REQUIRED for admin endpoints. No default in production. */
  adminPassword: string;
  /** Explicit serial device; auto-detected when empty. */
  serialPort: string;
  /** Run against the built-in firmware simulator instead of real hardware. */
  simulate: boolean;
  dataDir: string;
  /** Folder of community SVG/G-code drawings shown in the gallery. */
  galleryDir: string;
  /** Built frontend to serve statically (empty = API only). */
  staticDir: string;
  /** Plottable work area in mm — uploads are scaled to fit this. */
  workWidthMm: number;
  workHeightMm: number;
  /**
   * Physical sheet the drawing is placed on (short/long side in mm). Drawings
   * are auto-oriented (portrait/landscape) and scaled to fit this, then anchored
   * to the bottom-right corner. Must fit inside the work area either way up.
   */
  paperShortMm: number;
  paperLongMm: number;
  /** Blank margin kept on every edge of the sheet, mm (default 0.5" = 12.7). */
  paperPaddingMm: number;
  /**
   * Mirror the drawing horizontally so it reads correctly when the head starts
   * at the paper's bottom-right corner (machine +X points left across the page).
   */
  paperMirrorX: boolean;
  /**
   * Draw (pen-down) feedrate used when generating G-code, as a fallback only.
   * At runtime the board's tuned max feed (`$110`) is preferred; this is used
   * when no board is reachable (offline estimates). mm/min.
   */
  drawFeedMmMin: number;
  repoRoot: string;
}

/** Walk up from `startDir` to the repo root (the folder containing firmware/). */
export function findRepoRoot(startDir: string): string {
  let current = startDir;
  for (let depth = 0; depth < 8; depth++) {
    if (fs.existsSync(path.join(current, "firmware")) && fs.existsSync(path.join(current, "software"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Could not locate the plotter repo root above ${startDir} — the backend must run from inside the repo.`
  );
}

export function loadConfig(): BackendConfig {
  const repoRoot = findRepoRoot(__dirname);
  const backendRoot = path.join(repoRoot, "software", "backend");
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";
  if (!adminPassword) {
    // Refuse silently-insecure deployments but keep local testing friction-free.
    console.warn("[config] ADMIN_PASSWORD is not set — admin endpoints are DISABLED until you set it.");
  }
  const workWidthMm = Number(process.env.WORK_W_MM ?? 120);
  const workHeightMm = Number(process.env.WORK_H_MM ?? 120);
  // Default paper: the largest US-Letter-proportioned sheet (8.5:11) that fits
  // the work area either way up. The long side is capped by the smaller work
  // dimension so the sheet can be laid portrait OR landscape and still fit.
  const LETTER_SHORT_OVER_LONG = 8.5 / 11;
  const defaultPaperLong = Math.min(workWidthMm, workHeightMm);
  const defaultPaperShort = defaultPaperLong * LETTER_SHORT_OVER_LONG;
  return {
    httpPort: Number(process.env.PORT ?? 5180),
    host: process.env.HOST ?? "0.0.0.0",
    adminPassword,
    serialPort: process.env.PLOTTER_SERIAL ?? "",
    simulate: process.env.PLOTTER_SIMULATE === "1",
    dataDir: process.env.DATA_DIR ?? path.join(backendRoot, "data"),
    galleryDir: process.env.GALLERY_DIR ?? path.join(repoRoot, "drawings"),
    staticDir: process.env.STATIC_DIR ?? path.join(repoRoot, "software", "frontend", "dist"),
    workWidthMm,
    workHeightMm,
    paperShortMm: Number(process.env.PAPER_SHORT_MM ?? defaultPaperShort),
    paperLongMm: Number(process.env.PAPER_LONG_MM ?? defaultPaperLong),
    paperPaddingMm: Number(process.env.PAPER_PADDING_MM ?? 12.7),
    // Default false: a standard machine where +X points right (jog "←" = −X
    // moves the head left). Set PAPER_MIRROR_X=1 only for a mirrored mounting
    // where the head starts at the bottom-right corner with +X pointing left.
    paperMirrorX: process.env.PAPER_MIRROR_X ? process.env.PAPER_MIRROR_X === "1" : false,
    drawFeedMmMin: Number(process.env.DRAW_FEED_MM_MIN ?? 1500),
    repoRoot,
  };
}

/** Admin overrides for how a drawing is placed on the paper (all optional). */
export interface LayoutRequest {
  /** Fraction (0,1] of the max paper fit; omit for shrink-to-fit default. */
  fillFraction?: number | null;
  orientation?: "portrait" | "landscape" | null;
  /** Top-left of the drawing in the operator view (mm from page top-left). */
  positionXMm?: number | null;
  positionYMm?: number | null;
}

/**
 * Build the paper-layout options for the converter pipeline from config plus
 * the admin's per-job overrides. Null/omitted fields fall back to auto.
 */
export function paperLayoutOptions(config: BackendConfig, request?: LayoutRequest | null) {
  const options: {
    paperShortMm: number;
    paperLongMm: number;
    paddingMm: number;
    mirrorX: boolean;
    fillFraction?: number;
    orientation?: "portrait" | "landscape";
    positionXMm?: number;
    positionYMm?: number;
  } = {
    paperShortMm: config.paperShortMm,
    paperLongMm: config.paperLongMm,
    paddingMm: config.paperPaddingMm,
    mirrorX: config.paperMirrorX,
  };
  if (request?.fillFraction != null) options.fillFraction = request.fillFraction;
  if (request?.orientation != null) options.orientation = request.orientation;
  if (request?.positionXMm != null) options.positionXMm = request.positionXMm;
  if (request?.positionYMm != null) options.positionYMm = request.positionYMm;
  return options;
}
