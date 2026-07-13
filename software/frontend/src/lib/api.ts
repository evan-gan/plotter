// Typed fetch wrappers for the backend API. Admin calls attach the password
// from the session store; errors surface as thrown Error with the server's
// message so pages can show it directly.

import { adminPassword } from "./stores";
import { get } from "svelte/store";

export interface EtaBreakdown {
  seconds: number;
  motionSeconds: number;
  overheadSeconds: number;
  fixedSeconds: number;
  moveCount: number;
  penLifts: number;
  drawDistanceMm: number;
  travelDistanceMm: number;
  calibrated: boolean;
  liveSettings: boolean;
}

export interface OptimizeStats {
  polylinesBefore: number;
  polylinesAfter: number;
  penUpBeforeMm: number;
  penUpAfterMm: number;
  penLiftsBefore: number;
  penLiftsAfter: number;
}

export interface Job {
  id: string;
  name: string;
  status: "queued" | "plotting" | "paused" | "done" | "aborted" | "failed";
  createdAt: string;
  source: string;
  etaSeconds: number | null;
  lineCount: number;
  stats: OptimizeStats | null;
  error: string | null;
}

export interface GalleryEntry {
  id: string;
  name: string;
  fileName: string;
  kind: "svg" | "gcode";
  etaSeconds: number | null;
  penUpSavedMm: number | null;
  error: string | null;
}

export interface SubmissionPreview {
  previewSvg: string;
  gcodeLineCount: number;
  eta: EtaBreakdown;
  stats: OptimizeStats | null;
}

export interface StatusSnapshot {
  machine: { connected: boolean; port: string; state: string; mx: number; my: number };
  runner: { state: string; jobId: string | null; linesSent: number; lineTotal: number };
  busyWith: string | null;
  queueLength: number;
  simulated: boolean;
  workArea: { widthMm: number; heightMm: number };
  adminEnabled: boolean;
}

async function request<T>(path: string, options: RequestInit = {}, admin = false): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (admin) headers["x-admin-password"] = get(adminPassword);
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown, admin = false) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }, admin);

// ── public ──
export const api = {
  status: () => request<StatusSnapshot>("/api/status"),
  queue: () => request<{ jobs: Job[] }>("/api/queue"),
  gallery: () => request<{ entries: GalleryEntry[] }>("/api/gallery"),
  estimate: (input: { name?: string; svgText?: string; gcodeText?: string; optimize?: boolean }) =>
    post<SubmissionPreview>("/api/estimate", input),
  submit: (input: { name: string; svgText?: string; gcodeText?: string; optimize?: boolean }) =>
    post<{ job: Job; preview: SubmissionPreview }>("/api/submit", input),
  enqueueGalleryEntry: (id: string) => post<{ job: Job }>(`/api/gallery/${id}/enqueue`),

  // ── admin ──
  adminLogin: () => post<{ ok: boolean }>("/api/admin/login", {}, true),
  start: (jobId?: string) => post<{ job: Job }>("/api/admin/start", { jobId }, true),
  pause: () => post("/api/admin/pause", {}, true),
  resume: () => post("/api/admin/resume", {}, true),
  abort: () => post("/api/admin/abort", {}, true),
  reorder: (order: string[]) => post<{ jobs: Job[] }>("/api/admin/queue/reorder", { order }, true),
  deleteJob: (id: string) => request<{ jobs: Job[] }>(`/api/admin/queue/${id}`, { method: "DELETE" }, true),
  connect: () => post("/api/admin/connect", {}, true),
  jog: (dx: number, dy: number, feed?: number) => post("/api/admin/jog", { dx, dy, feed }, true),
  setHome: () => post("/api/admin/home", {}, true),
  steppers: (enabled: boolean) => post("/api/admin/steppers", { enabled }, true),
  pen: (down: boolean) => post("/api/admin/pen", { down }, true),
  settings: () => request<{ settings: Record<string, number> }>("/api/admin/settings", {}, true),
  setSetting: (key: string, value: number) =>
    post<{ settings: Record<string, number> }>("/api/admin/settings", { key, value }, true),
  resetDefaults: () => post<{ settings: Record<string, number> }>("/api/admin/reset-defaults", {}, true),
  drawShape: (shape: string) => post("/api/admin/shape", { shape }, true),
  tuneStart: (mode: string, tests: string) => post("/api/admin/tune/start", { mode, tests }, true),
  tuneVerdict: (v: string) => post("/api/admin/tune/verdict", { v }, true),
  tuneStop: () => post("/api/admin/tune/stop", {}, true),
  calibrate: () => post("/api/admin/calibrate", {}, true),
  saveCalibration: () => post("/api/admin/calibrate/save", {}, true),
};
