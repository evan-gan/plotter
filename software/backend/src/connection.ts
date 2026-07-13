// GRBL-subset protocol logic, transport-agnostic.
//
// TS port of firmware/tools/lib/serial.js's Connection: line events,
// send-and-wait-for-ok, `?` status parsing, waitIdle polling, `$$` parsing.
// Subclasses provide the transport: SerialConnection (real hardware) and
// SimulatedConnection (built-in firmware sim for serial-less development).

import { EventEmitter } from "events";

export type SendResult = "ok" | `error:${number}` | "timeout";

export interface MachineStatus {
  state: string;
  mx: number;
  my: number;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export abstract class BaseConnection extends EventEmitter {
  /** Write raw bytes with no terminator (realtime commands: ?, !, ~, 0x18). */
  abstract sendRaw(data: string | Uint8Array): void;
  /** Write one G-code/`$` line with the trailing newline the firmware expects. */
  abstract sendLineRaw(line: string): void;
  abstract close(): Promise<void>;
  abstract readonly description: string;

  /** Subclasses call this for every complete received line (CR stripped). */
  protected receiveLine(line: string): void {
    this.emit("line", line.replace(/\r$/, ""));
  }

  /**
   * Resolve with the first received line matching `regex`, or null on timeout.
   * Attached synchronously so a fast reply can't be missed.
   */
  waitFor(regex: RegExp, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const onLine = (line: string) => {
        if (regex.test(line)) {
          cleanup();
          resolve(line);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("line", onLine);
      };
      this.on("line", onLine);
    });
  }

  /** Send a line and wait for the firmware's ok/error acknowledgement. */
  async sendLine(line: string, timeoutMs = 10000): Promise<SendResult> {
    const replyPromise = this.waitFor(/^ok$|^error:\d+/, timeoutMs);
    this.sendLineRaw(line);
    const reply = await replyPromise;
    if (reply === null) return "timeout";
    if (reply === "ok") return "ok";
    const match = reply.match(/error:(\d+)/);
    return match ? (`error:${Number(match[1])}` as SendResult) : "timeout";
  }

  /** `?` realtime status query. */
  async status(timeoutMs = 800): Promise<MachineStatus> {
    const replyPromise = this.waitFor(/<\w+\|MPos:[-\d.]+,[-\d.]+/, timeoutMs);
    this.sendRaw("?");
    const line = await replyPromise;
    if (!line) return { state: "Unknown", mx: 0, my: 0 };
    const match = line.match(/<(\w+)\|MPos:([-\d.]+),([-\d.]+)/);
    if (!match) return { state: "Unknown", mx: 0, my: 0 };
    return { state: match[1], mx: parseFloat(match[2]), my: parseFloat(match[3]) };
  }

  /** Poll `?` until the firmware reports Idle. */
  async waitIdle(timeoutMs = 120000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { state } = await this.status();
      if (state === "Idle") return;
      await delay(150);
    }
    throw new Error("Timed out waiting for the firmware to return to Idle.");
  }

  /** `$$` settings dump, parsed into { "$110": 3000, ... }. */
  settings(timeoutMs = 3000): Promise<Record<string, number>> {
    const values: Record<string, number> = {};
    const done = new Promise<void>((resolve) => {
      const onLine = (line: string) => {
        const match = line.match(/(\$\d+)=([-\d.]+)/);
        if (match) values[match[1]] = parseFloat(match[2]);
        if (line === "ok") {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("line", onLine);
      };
      this.on("line", onLine);
    });
    this.sendLineRaw("$$");
    return done.then(() => values);
  }
}
