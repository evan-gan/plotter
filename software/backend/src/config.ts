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
  return {
    httpPort: Number(process.env.PORT ?? 5180),
    host: process.env.HOST ?? "0.0.0.0",
    adminPassword,
    serialPort: process.env.PLOTTER_SERIAL ?? "",
    simulate: process.env.PLOTTER_SIMULATE === "1",
    dataDir: process.env.DATA_DIR ?? path.join(backendRoot, "data"),
    galleryDir: process.env.GALLERY_DIR ?? path.join(repoRoot, "drawings"),
    staticDir: process.env.STATIC_DIR ?? path.join(repoRoot, "software", "frontend", "dist"),
    workWidthMm: Number(process.env.WORK_W_MM ?? 120),
    workHeightMm: Number(process.env.WORK_H_MM ?? 120),
    drawFeedMmMin: Number(process.env.DRAW_FEED_MM_MIN ?? 1500),
    repoRoot,
  };
}
