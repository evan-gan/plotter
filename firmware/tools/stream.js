#!/usr/bin/env node
"use strict";
// plotter-stream — send a G-code file line by line with ok/error flow control.
//
// Sends one line, waits for the firmware's `ok` (or `error:N`), then sends the
// next. Long moves can delay `ok` because the firmware holds it until there's
// room in the planner buffer; while waiting we poll `?` so you can see it's
// still alive rather than guessing it hung.
//
// Usage:
//   pnpm stream -- patterns/spiral_square.gcode
//   pnpm stream -- patterns/spiral_square.gcode --port /dev/cu.usbmodemXXXX

const fs = require("fs");
const { BAUD, resolvePort, open, delay, parseArgs } = require("./lib/serial");

const PER_LINE_TIMEOUT_MS = 60000;
const PROGRESS_POLL_MS = 500; // how often to `?`-poll while a slow line is in flight
const SLOW_LINE_THRESHOLD_MS = 1500; // only report progress once a line takes this long

/**
 * Send one line and wait for ok/error, polling status for slow moves.
 * @returns {Promise<{status: string, slow: boolean, elapsedMs: number}>}
 */
async function sendWithProgress(connection, line, index) {
  const start = Date.now();
  const replyPromise = connection.waitFor(/^ok$|^error:\d+/, PER_LINE_TIMEOUT_MS);
  connection.sendLineRaw(line);

  let reply = null;
  let slow = false;
  let settled = false;
  replyPromise.then((value) => {
    reply = value;
    settled = true;
  });

  // Poll `?` until the line is acknowledged so a blocking move shows progress.
  while (!settled) {
    await delay(PROGRESS_POLL_MS);
    if (settled) break;
    if (Date.now() - start > SLOW_LINE_THRESHOLD_MS) {
      if (!slow) {
        process.stdout.write(
          `   .. [${String(index).padStart(3)}] ${line.padEnd(30)}  waiting…\n`
        );
        slow = true;
      }
      const { state, mx, my } = await connection.status();
      process.stdout.write(
        `        <${state} MPos:${mx.toFixed(3)},${my.toFixed(3)}>\n`
      );
    }
  }

  await replyPromise;
  const elapsedMs = Date.now() - start;
  if (reply === null) return { status: "timeout", slow, elapsedMs };
  if (reply === "ok") return { status: "ok", slow, elapsedMs };
  const match = reply.match(/error:(\d+)/);
  return { status: match ? `error:${match[1]}` : "timeout", slow, elapsedMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    process.stderr.write("Usage: pnpm stream -- <file.gcode> [--port PORT]\n");
    process.exit(1);
  }
  const baud = args.baud ? Number(args.baud) : BAUD;
  const path = await resolvePort(args.port);

  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(`Can't read ${file}: ${err.message}\n`);
    process.exit(1);
  }
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(";"));

  let connection;
  try {
    connection = await open(path, baud);
  } catch (err) {
    process.stderr.write(
      `Can't open ${path}: ${err.message}\nIs another program using the port?\n`
    );
    process.exit(1);
  }

  console.log(`Streaming ${lines.length} lines from ${file} to ${path}…\n`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const { status, slow, elapsedMs } = await sendWithProgress(connection, line, i + 1);
    const mark = status === "ok" ? "  " : "!!";
    const timing = slow ? `  (took ${(elapsedMs / 1000).toFixed(1)}s)` : "";
    console.log(`${mark} [${String(i + 1).padStart(3)}] ${line.padEnd(30)}  →  ${status}${timing}`);

    if (status.startsWith("error")) {
      console.log("\n  Stopping on error.");
      await connection.close();
      process.exit(1);
    }
    if (status === "timeout") {
      console.log("\n  Timed out waiting for ok — the firmware is likely hung.");
      await connection.close();
      process.exit(1);
    }
  }

  console.log("\nDone. All lines accepted by firmware.");
  await connection.close();
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
