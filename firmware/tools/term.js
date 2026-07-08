#!/usr/bin/env node
"use strict";
// plotter-term — interactive G-code sender / serial monitor.
//
// Keys:
//   Enter        → send the current line
//   ?            → realtime status query (only when the line is empty)
//   Ctrl+X       → soft reset (0x18)
//   Backspace    → edit the current line
//   Ctrl+C / D   → quit
//
// Usage:
//   pnpm term                       # auto-detect port
//   pnpm term -- --port /dev/cu.usbmodemXXXX
//   pnpm term -- --baud 115200

const { BAUD, resolvePort, open, parseArgs } = require("./lib/serial");

// Bytes we intercept from raw stdin.
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const CTRL_X = 0x18;
const ENTER = [0x0d, 0x0a];
const BACKSPACE = [0x7f, 0x08];

/** Colour-coded prefix so stateful firmware replies are easy to scan. */
function formatIncoming(line) {
  if (!line) return null;
  if (line.startsWith("error")) return `  ! ${line}`;
  return `  ${line}`; // status reports, $ responses, ok, everything else
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baud = args.baud ? Number(args.baud) : BAUD;
  const path = await resolvePort(args.port);

  let connection;
  try {
    connection = await open(path, baud);
  } catch (err) {
    process.stderr.write(`Can't open ${path}: ${err.message}\n`);
    process.exit(1);
  }

  let lineBuffer = "";
  const redrawPrompt = () => process.stdout.write(`\r> ${lineBuffer}\x1b[K`);

  connection.on("line", (line) => {
    const text = formatIncoming(line);
    if (text === null) return;
    // Clear the current input line, print the incoming text, restore the prompt.
    process.stdout.write("\r\x1b[K");
    process.stdout.write(text + "\n");
    redrawPrompt();
  });

  console.log(`plotter-term — connected to ${path} @ ${baud}`);
  console.log("Type G-code, Enter to send. ? = status, Ctrl+X = reset, Ctrl+C = quit.\n");
  redrawPrompt();

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => handleInput(chunk));

  const quit = async () => {
    process.stdin.setRawMode(false);
    await connection.close();
    process.stdout.write("\nbye.\n");
    process.exit(0);
  };

  function handleInput(chunk) {
    for (const byte of chunk) {
      if (byte === CTRL_C || byte === CTRL_D) {
        quit();
        return;
      }
      if (byte === CTRL_X) {
        connection.sendRaw(Buffer.from([0x18]));
        process.stdout.write("\r\x1b[K  [0x18 soft reset sent]\n");
        redrawPrompt();
        continue;
      }
      if (ENTER.includes(byte)) {
        submitLine();
        continue;
      }
      if (BACKSPACE.includes(byte)) {
        lineBuffer = lineBuffer.slice(0, -1);
        redrawPrompt();
        continue;
      }
      // A bare `?` on an empty line is a realtime status query, not text.
      if (byte === 0x3f && lineBuffer === "") {
        connection.sendRaw("?");
        continue;
      }
      // Printable ASCII only — ignore stray control bytes.
      if (byte >= 0x20 && byte < 0x7f) {
        lineBuffer += String.fromCharCode(byte);
        redrawPrompt();
      }
    }
  }

  function submitLine() {
    const line = lineBuffer.trim();
    lineBuffer = "";
    process.stdout.write("\n");
    if (line) connection.sendLineRaw(line);
    redrawPrompt();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
