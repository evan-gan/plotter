// Built-in firmware simulator: a BaseConnection that behaves like the real
// board closely enough to develop and demo the whole stack with no hardware.
//
// It models: ok/error acks, a motion queue timed from the modal feed and the
// $110 max, `?` status with interpolated MPos and Idle/Run/Hold states,
// feed hold (!) / resume (~) / soft reset (0x18), `$$` dumps, `$N=` writes,
// `$RST=*`, M3/M5 pen dwell, and G4 dwells. It is NOT a physics replica —
// timing uses straight distance/speed with no accel model.

import { BaseConnection } from "./connection";

interface QueuedMotion {
  targetX: number;
  targetY: number;
  durationMs: number;
}

const SIM_DEFAULT_SETTINGS: Record<string, number> = {
  $100: 80, $101: 80,
  $110: 1500, $111: 1500, $112: 1500,
  $120: 200, $122: 500,
  $140: 0.05, $141: 0.002,
};
const SIM_PEN_MOVE_MS = 150;
const SIM_TIME_SCALE = Number(process.env.PLOTTER_SIM_TIME_SCALE ?? 1);

export class SimulatedConnection extends BaseConnection {
  readonly description = "simulated plotter";
  private settingsMap: Record<string, number> = { ...SIM_DEFAULT_SETTINGS };
  private queue: QueuedMotion[] = [];
  private position = { x: 0, y: 0 };
  private queueStartedAt = 0; // wall time the head motion began
  private holding = false;
  private holdEnteredAt = 0;
  private feedMmMin = 750; // firmware power-on modal default
  private absolute = true;
  private unitScale = 1;
  private closed = false;

  sendRaw(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
    for (const ch of text) this.handleRealtime(ch);
  }

  sendLineRaw(line: string): void {
    if (this.closed) return;
    // Async like a real port: reply on the next tick, never synchronously.
    setImmediate(() => this.handleLine(line.trim()));
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  // ── realtime bytes ──
  private handleRealtime(ch: string): void {
    if (ch === "?") {
      this.advanceQueue();
      const state = this.holding ? "Hold" : this.queue.length > 0 ? "Run" : "Idle";
      const { x, y } = this.currentPosition();
      setImmediate(() => this.receiveLine(`<${state}|MPos:${x.toFixed(3)},${y.toFixed(3)}|FS:0,0>`));
    } else if (ch === "!") {
      if (!this.holding) {
        this.advanceQueue();
        this.holding = true;
        this.holdEnteredAt = Date.now();
      }
    } else if (ch === "~") {
      if (this.holding) {
        // Shift the timeline by the held duration so motion resumes cleanly.
        this.queueStartedAt += Date.now() - this.holdEnteredAt;
        this.holding = false;
      }
    } else if (ch === "\x18") {
      this.queue = [];
      this.holding = false;
      setImmediate(() => this.receiveLine("Grbl 1.1 ['$' for help] (simulated)"));
    }
  }

  // ── line protocol ──
  private handleLine(line: string): void {
    if (line === "") return this.receiveLine("ok");
    if (line === "$$") return this.dumpSettings();
    if (line === "$RST=*") {
      this.settingsMap = { ...SIM_DEFAULT_SETTINGS };
      return this.receiveLine("ok");
    }
    const settingWrite = line.match(/^\$(\d+)=([-\d.]+)$/);
    if (settingWrite) {
      this.settingsMap[`$${settingWrite[1]}`] = parseFloat(settingWrite[2]);
      return this.receiveLine("ok");
    }
    if (line.startsWith("$")) return this.receiveLine("error:3");
    this.handleGcode(line);
    this.receiveLine("ok");
  }

  private dumpSettings(): void {
    for (const key of Object.keys(this.settingsMap).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
      this.receiveLine(`${key}=${this.settingsMap[key]}`);
    }
    this.receiveLine("ok");
  }

  private handleGcode(line: string): void {
    const clean = line.replace(/\(.*?\)/g, "").replace(/;.*$/, "").trim();
    if (!clean) return;
    if (/\bG20\b/i.test(clean)) this.unitScale = 25.4;
    if (/\bG21\b/i.test(clean)) this.unitScale = 1;
    if (/\bG90\b/i.test(clean)) this.absolute = true;
    if (/\bG91\b/i.test(clean)) this.absolute = false;
    if (/\bM0?[35]\b/i.test(clean)) this.enqueueDwell(SIM_PEN_MOVE_MS);
    const dwell = clean.match(/\bG4\b.*?P\s*(-?\d*\.?\d+)/i);
    if (dwell) this.enqueueDwell(Math.max(0, parseFloat(dwell[1])));

    const feedWord = clean.match(/F\s*(-?\d*\.?\d+)/i);
    if (feedWord) this.feedMmMin = parseFloat(feedWord[1]) * this.unitScale;

    const isRapid = /\bG0?0\b/i.test(clean);
    const xWord = clean.match(/X\s*(-?\d*\.?\d+)/i);
    const yWord = clean.match(/Y\s*(-?\d*\.?\d+)/i);
    if (/\bG92\b/i.test(clean)) {
      // Re-zero: the simulator just moves its notion of position.
      this.advanceQueue();
      const current = this.currentPosition();
      this.position = {
        x: xWord ? current.x - (current.x - parseFloat(xWord[1]) * this.unitScale) : current.x,
        y: yWord ? current.y - (current.y - parseFloat(yWord[1]) * this.unitScale) : current.y,
      };
      this.queue = [];
      return;
    }
    if (!xWord && !yWord) return;

    const from = this.queueEndPosition();
    const target = {
      x: xWord ? (this.absolute ? parseFloat(xWord[1]) * this.unitScale : from.x + parseFloat(xWord[1]) * this.unitScale) : from.x,
      y: yWord ? (this.absolute ? parseFloat(yWord[1]) * this.unitScale : from.y + parseFloat(yWord[1]) * this.unitScale) : from.y,
    };
    const lengthMm = Math.hypot(target.x - from.x, target.y - from.y);
    const speedMmMin = Math.min(isRapid ? this.settingsMap["$110"] : this.feedMmMin || this.settingsMap["$110"], this.settingsMap["$110"]);
    const durationMs = ((lengthMm / Math.max(speedMmMin, 1)) * 60000) / SIM_TIME_SCALE;
    this.enqueueMotion(target.x, target.y, durationMs);
  }

  // ── motion timeline ──
  private enqueueMotion(targetX: number, targetY: number, durationMs: number): void {
    this.advanceQueue();
    if (this.queue.length === 0) this.queueStartedAt = Date.now();
    this.queue.push({ targetX, targetY, durationMs });
  }

  private enqueueDwell(ms: number): void {
    const end = this.queueEndPosition();
    this.enqueueMotion(end.x, end.y, ms / SIM_TIME_SCALE);
  }

  private queueEndPosition(): { x: number; y: number } {
    const last = this.queue[this.queue.length - 1];
    return last ? { x: last.targetX, y: last.targetY } : { ...this.position };
  }

  /** Retire queued motions whose time has fully elapsed. */
  private advanceQueue(): void {
    if (this.holding) return;
    let now = Date.now();
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (now - this.queueStartedAt < head.durationMs) break;
      this.queueStartedAt += head.durationMs;
      this.position = { x: head.targetX, y: head.targetY };
      this.queue.shift();
    }
    if (this.queue.length === 0) this.queueStartedAt = now;
  }

  /** Interpolated position inside the currently-executing motion. */
  private currentPosition(): { x: number; y: number } {
    if (this.queue.length === 0) return { ...this.position };
    const head = this.queue[0];
    const reference = this.holding ? this.holdEnteredAt : Date.now();
    const progress = Math.min(1, Math.max(0, (reference - this.queueStartedAt) / Math.max(head.durationMs, 1)));
    return {
      x: this.position.x + (head.targetX - this.position.x) * progress,
      y: this.position.y + (head.targetY - this.position.y) * progress,
    };
  }
}
