// Shared client state: the SSE event stream fanned out into focused stores
// that components subscribe to. One EventSource per tab, auto-reconnect.

import { writable } from "svelte/store";

export interface LogLine {
  text: string;
  at: number;
}

export interface ProgressEvent {
  jobId: string;
  linesSent: number;
  lineTotal: number;
  elapsedSeconds: number;
  etaSeconds: number | null;
  state: string;
}

export interface TunePrompt {
  [key: string]: unknown;
}

/** Admin password for this browser session (never persisted to localStorage). */
export const adminPassword = writable<string>(sessionStorage.getItem("adminPassword") ?? "");
adminPassword.subscribe((value) => sessionStorage.setItem("adminPassword", value));

export const serialConnected = writable<boolean>(false);
export const serialPort = writable<string | null>(null);
export const logLines = writable<LogLine[]>([]);
export const progress = writable<ProgressEvent | null>(null);
export const queueVersion = writable(0); // bumped when the queue changes server-side
export const tuneRunning = writable(false);
export const tunePrompt = writable<TunePrompt | null>(null);
export const tuneSettings = writable<Record<string, number> | null>(null);
export const tuneSummary = writable<unknown[] | null>(null);
export const calRows = writable<unknown[]>([]);
export const calSummary = writable<{ rows: unknown[]; calibration: Record<string, number> } | null>(null);
export const calRunning = writable(false);
export const calSaved = writable<Record<string, unknown> | null>(null);
export const eventsConnected = writable(false);

const MAX_LOG_LINES = 400;

function handleEvent(event: { type: string; [key: string]: unknown }): void {
  switch (event.type) {
    case "log":
      logLines.update((lines) => [...lines.slice(-MAX_LOG_LINES), { text: String(event.text), at: Number(event.at ?? Date.now()) }]);
      break;
    case "serial":
      serialConnected.set(Boolean(event.connected));
      serialPort.set((event.port as string) ?? null);
      break;
    case "progress":
      progress.set(event as unknown as ProgressEvent);
      break;
    case "plotFinished":
      progress.set(null);
      queueVersion.update((version) => version + 1);
      break;
    case "queueChanged":
      queueVersion.update((version) => version + 1);
      break;
    case "runnerState":
      if (event.state && event.state !== "idle") {
        progress.set(event as unknown as ProgressEvent);
      }
      break;
    case "tune:running":
      tuneRunning.set(Boolean(event.running));
      if (!event.running) tunePrompt.set(null);
      break;
    case "tune:state":
      tuneRunning.set(Boolean(event.running));
      tunePrompt.set((event.prompt as TunePrompt) ?? null);
      break;
    case "tune:prompt":
      tunePrompt.set(event);
      break;
    case "tune:clearPrompt":
      tunePrompt.set(null);
      break;
    case "tune:settings":
      tuneSettings.set(event.values as Record<string, number>);
      break;
    case "tune:summary":
      tuneSummary.set(event.rows as unknown[]);
      break;
    case "cal:start":
      calRunning.set(true);
      calRows.set([]);
      calSummary.set(null);
      break;
    case "cal:row":
      calRows.update((rows) => [...rows, event.row]);
      break;
    case "cal:summary":
      calSummary.set({ rows: event.rows as unknown[], calibration: event.calibration as Record<string, number> });
      break;
    case "cal:done":
      calRunning.set(false);
      break;
    case "cal:saved":
      calSaved.set(event.calibration as Record<string, unknown>);
      break;
  }
}

let source: EventSource | null = null;

/** Open the SSE stream (idempotent). Reconnects automatically on drop. */
export function connectEvents(): void {
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => eventsConnected.set(true);
  source.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data));
    } catch {
      /* malformed event — ignore */
    }
  };
  source.onerror = () => {
    eventsConnected.set(false);
    source?.close();
    source = null;
    setTimeout(connectEvents, 2000);
  };
}
