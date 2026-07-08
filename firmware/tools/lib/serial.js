"use strict";
// Shared serial plumbing for the plotter tools (term/stream/tune).
//
// The firmware speaks a GRBL subset over USB serial at 115200 baud: text lines
// terminated with CRLF, `ok`/`error:N` flow control, and realtime single-byte
// commands (`?` status, 0x18 soft reset). Everything here is built around those
// three facts. Ported from the original Python tools (pyserial).

const { EventEmitter } = require("events");
const { SerialPort, ReadlineParser } = require("serialport");

const BAUD = 115200;

// USB-serial device name patterns across platforms. macOS exposes both a
// `tty.*` (blocking) and `cu.*` (non-blocking) node for the same device; we
// always want `cu.*` for a call-out connection, so we rewrite it below.
const USB_PORT_PATTERN = /usbmodem|usbserial|ttyACM|ttyUSB/i;

/**
 * Pick the serial port to use.
 *
 * @param {string|undefined} preferred Explicit port from --port, if any.
 * @returns {Promise<string>} The chosen device path.
 */
async function resolvePort(preferred) {
  if (preferred) return preferred;

  const ports = await SerialPort.list();
  const candidates = ports
    .map((entry) => entry.path)
    .filter((path) => USB_PORT_PATTERN.test(path))
    // On macOS, prefer the cu.* call-out node over the tty.* dial-in node.
    .map((path) =>
      process.platform === "darwin"
        ? path.replace("/dev/tty.", "/dev/cu.")
        : path
    );

  if (candidates.length === 0) {
    throw new Error(
      "No plotter serial port found. Plug in the board (it must be running " +
        "firmware, not mounted as the RPI-RP2 bootloader drive), or pass --port."
    );
  }
  return candidates[0];
}

/**
 * A line-oriented serial connection to the firmware. Emits `line` for every
 * complete CRLF-terminated line received, and provides request/response helpers
 * that wait for the firmware's `ok`/`error`/status replies.
 */
class Connection extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    // The firmware terminates lines with \n (CRLF); split on \n, strip the \r.
    const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
    parser.on("data", (raw) => this.emit("line", raw.replace(/\r$/, "")));
  }

  /** Write raw bytes/string with no added terminator (for realtime commands). */
  sendRaw(bytesOrString) {
    this.port.write(bytesOrString);
  }

  /** Write one G-code/`$` line with the trailing newline the firmware expects. */
  sendLineRaw(line) {
    this.port.write(line + "\n");
  }

  /**
   * Resolve with the first received line matching `regex`, or null on timeout.
   * The listener is attached synchronously so replies can't be missed.
   */
  waitFor(regex, timeoutMs) {
    return new Promise((resolve) => {
      const onLine = (line) => {
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

  /**
   * Send a line and wait for the firmware's acknowledgement.
   * @returns {Promise<"ok"|`error:${number}`|"timeout">}
   */
  async sendLine(line, timeoutMs = 10000) {
    this.sendLineRaw(line);
    const reply = await this.waitFor(/^ok$|^error:\d+/, timeoutMs);
    if (reply === null) return "timeout";
    if (reply === "ok") return "ok";
    const match = reply.match(/error:(\d+)/);
    return match ? `error:${match[1]}` : "timeout";
  }

  /**
   * Send a `?` realtime status query and parse the report.
   * @returns {Promise<{state: string, mx: number, my: number}>}
   */
  async status(timeoutMs = 800) {
    this.sendRaw("?");
    const line = await this.waitFor(/<\w+\|MPos:[-\d.]+,[-\d.]+/, timeoutMs);
    if (!line) return { state: "Unknown", mx: 0, my: 0 };
    const match = line.match(/<(\w+)\|MPos:([-\d.]+),([-\d.]+)/);
    return {
      state: match[1],
      mx: parseFloat(match[2]),
      my: parseFloat(match[3]),
    };
  }

  /** Poll status until the firmware reports Idle, or throw on timeout. */
  async waitIdle(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { state } = await this.status();
      if (state === "Idle") return;
      await delay(150);
    }
    throw new Error("Timed out waiting for the firmware to return to Idle.");
  }

  /**
   * Send `$$` and parse the settings dump.
   * @returns {Promise<Record<string, number>>} e.g. { "$110": 3000, ... }
   */
  async settings(timeoutMs = 3000) {
    const values = {};
    const done = new Promise((resolve) => {
      const onLine = (line) => {
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
    await done;
    return values;
  }

  close() {
    return new Promise((resolve) => {
      if (this.port.isOpen) this.port.close(() => resolve());
      else resolve();
    });
  }
}

/**
 * Open a serial connection and settle it (RP2040 USB CDC needs a moment after
 * open before it reliably accepts input; we also flush any boot banner).
 */
async function open(path, baud = BAUD) {
  const port = await new Promise((resolve, reject) => {
    const candidate = new SerialPort({ path, baudRate: baud }, (err) =>
      err ? reject(err) : resolve(candidate)
    );
  });
  const connection = new Connection(port);
  await delay(500);
  port.flush();
  return connection;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tiny `--flag value` / `--flag` parser. Returns { _: [positional], flag: val }.
 * Bare flags (no following value, or followed by another --flag) become `true`.
 */
function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") continue; // stray separator from `pnpm run <script> -- …`
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        result[key] = true;
      } else {
        result[key] = next;
        i++;
      }
    } else {
      result._.push(token);
    }
  }
  return result;
}

module.exports = { BAUD, Connection, resolvePort, open, delay, parseArgs };
