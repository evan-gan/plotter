#!/usr/bin/env node
"use strict";
// plotter-tune — browser-based speed/acceleration tuner.
//
// Opens the serial connection, then serves a tiny local web page that walks you
// through the tuning procedure (the same one the old tune.py ran on the command
// line). The page is the control surface: it shows each test's current value and
// the pen's end position, and you click Pass / Fail / Retry / Quit. All the
// tuning logic lives in lib/tune-engine.js; this file is just the serial↔browser
// bridge (HTTP for the page, Server-Sent Events for live output, POST for input).
//
// Usage:
//   pnpm tune                          # auto-detect port, serve on :7373
//   pnpm tune -- --port /dev/cu.usbmodemXXXX
//   pnpm tune -- --http-port 8080

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { BAUD, resolvePort, open, parseArgs } = require("./lib/serial");
const { runSession } = require("./lib/tune-engine");

const DEFAULT_HTTP_PORT = 7373;
const UI_FILE = path.join(__dirname, "tune-ui.html");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baud = args.baud ? Number(args.baud) : BAUD;
  const httpPort = args["http-port"] ? Number(args["http-port"]) : DEFAULT_HTTP_PORT;
  const serialPath = await resolvePort(args.port);

  let connection;
  try {
    connection = await open(serialPath, baud);
  } catch (err) {
    process.stderr.write(
      `Can't open ${serialPath}: ${err.message}\nIs another program using the port?\n`
    );
    process.exit(1);
  }

  // ───────── live-output fan-out (Server-Sent Events) ─────────
  const clients = new Set();
  const broadcast = (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  // Surface firmware-reported errors in the browser console too.
  connection.on("line", (line) => {
    if (line.startsWith("error")) broadcast({ type: "log", text: `  ! ${line}` });
  });

  // ───────── session state + operator I/O bridge ─────────
  let running = false;
  let aborting = false;
  let resolveVerdict = null;

  const io = {
    log: (text) => broadcast({ type: "log", text }),
    settings: (values) => broadcast({ type: "settings", values }),
    summary: (rows) => broadcast({ type: "summary", rows }),
    verdict: (context) =>
      new Promise((resolve) => {
        if (aborting) return resolve("q");
        resolveVerdict = resolve;
        broadcast({ type: "prompt", ...context });
      }),
  };

  const startSession = (mode, tests) => {
    if (running) return;
    running = true;
    aborting = false;
    broadcast({ type: "running", running: true });
    runSession(connection, { mode, tests, io })
      .then(() => broadcast({ type: "log", text: "\nDone. Values persist across power cycles." }))
      .catch((err) => broadcast({ type: "log", text: `\n! Session error: ${err.message}` }))
      .finally(() => {
        running = false;
        resolveVerdict = null;
        broadcast({ type: "running", running: false });
      });
  };

  const submitVerdict = (value) => {
    if (!resolveVerdict) return;
    const resolve = resolveVerdict;
    resolveVerdict = null;
    broadcast({ type: "clearPrompt" });
    resolve(value);
  };

  const stopSession = () => {
    aborting = true;
    submitVerdict("q");
  };

  // A 20 mm-diameter test circle, centred at (10,10) so it stays within the
  // +X/+Y free-travel the operator cleared for tuning. Uses the firmware's
  // on-device G2 arc: start==end with an I/J offset draws one full revolution.
  // Plain `M3` (no S) so the operator's calibrated pen-down height is untouched.
  // `feed` (mm/min, optional) sets the modal feedrate before the arc — omit it
  // to draw at whatever feed is already modal; pass a low value for a slow pass
  // that makes backlash flat-spots easier to see at the four diagonal points.
  const circleGcode = (feed) => [
    "G21 G90",                       // mm, absolute
    "M17",                           // motors on
    "G92 X0 Y0",                     // zero here
    "G0 X10 Y0",                     // move to the bottom of the circle
    ...(feed ? [`G1 F${feed}`] : []),// set the (slow) feed if requested
    "M3",                            // pen down
    "G4 P100",                       // let the pen settle
    feed ? `G2 X10 Y0 I0 J10 F${feed}` // full clockwise circle about (10,10)
         : "G2 X10 Y0 I0 J10",
    "M5",                            // pen up
    "G0 X0 Y0",                      // return to origin
    "M18",                           // motors off
  ];

  // Backlash cross: from a common centre, draw each of four strokes out to the
  // tip and straight back over itself. Any lost motion in the belts shows up as
  // the return stroke NOT overlapping the outbound one — a visible double line
  // whose separation equals the backlash. The two cardinal strokes (±X, ±Y)
  // drive both motors; the two diagonal strokes (±45°) each drive a SINGLE
  // CoreXY belt, so they isolate which belt has the slop. Drawn slowly so the
  // reversal is clean and the gap is purely mechanical, not inertial overshoot.
  const BACKLASH_FEED_MM_MIN = 400; // 6.7 mm/s — slow enough to expose slack
  const BACKLASH_CENTER = 15;       // mm, keeps the whole cross in +X/+Y travel
  const BACKLASH_ARM = 12;          // mm, stroke half-length
  const backlashGcode = () => {
    const center = BACKLASH_CENTER;
    const arm = BACKLASH_ARM;
    // [dx, dy] unit-ish directions for the four strokes out from centre.
    const strokes = [
      [1, 0],   // +X
      [0, 1],   // +Y
      [1, 1],   // +45° (one belt)
      [1, -1],  // −45° (the other belt)
    ];
    const lines = [
      "G21 G90",
      "M17",
      "G92 X0 Y0",
      `G0 X${center} Y${center}`,       // park at the cross centre
      `G1 F${BACKLASH_FEED_MM_MIN}`,
    ];
    for (const [dx, dy] of strokes) {
      const tipX = (center + dx * arm).toFixed(2);
      const tipY = (center + dy * arm).toFixed(2);
      lines.push("M3", "G4 P100");       // pen down at centre
      lines.push(`G1 X${tipX} Y${tipY}`); // out to the tip
      lines.push(`G1 X${center} Y${center}`); // back over the same line
      lines.push("M5");                  // pen up before repositioning
    }
    lines.push("G0 X0 Y0", "M18");
    return lines;
  };

  // Restore every persisted setting to its compile-time default via the GRBL
  // `$RST=*` command, then re-read `$$` so the browser table reflects it.
  const resetDefaults = () => {
    if (running) return;
    running = true;
    broadcast({ type: "running", running: true });
    broadcast({ type: "log", text: "\nRestoring firmware defaults ($RST=*)…" });
    (async () => {
      const reply = await connection.sendLine("$RST=*", 15000);
      if (reply.startsWith("error")) {
        broadcast({ type: "log", text: `  ! $RST=* → ${reply}` });
      } else {
        broadcast({ type: "log", text: "Defaults restored." });
      }
      io.settings(await connection.settings());
    })()
      .catch((err) => broadcast({ type: "log", text: `\n! Reset error: ${err.message}` }))
      .finally(() => {
        running = false;
        broadcast({ type: "running", running: false });
      });
  };

  // Stream one G-code program line-by-line with ok/error flow control, then
  // wait for the machine to go idle. Shared by every "draw a shape" button.
  const runProgram = (label, lines, doneText) => {
    if (running) return;
    running = true;
    broadcast({ type: "running", running: true });
    broadcast({ type: "log", text: `\n${label}` });
    (async () => {
      for (const line of lines) {
        const reply = await connection.sendLine(line, 15000);
        if (reply.startsWith("error")) broadcast({ type: "log", text: `  ! [${line}] → ${reply}` });
      }
      await connection.waitIdle();
    })()
      .then(() => broadcast({ type: "log", text: doneText }))
      .catch((err) => broadcast({ type: "log", text: `\n! ${label} error: ${err.message}` }))
      .finally(() => {
        running = false;
        broadcast({ type: "running", running: false });
      });
  };

  // Set the feed explicitly (matches the firmware's power-on default modal
  // feed) so the normal circle is deterministic even after "Draw circle
  // slowly" has left a lower feed modal on the board.
  const CIRCLE_FEED_MM_MIN = 750;
  const runCircle = () =>
    runProgram("Drawing 20 mm test circle…", circleGcode(CIRCLE_FEED_MM_MIN), "Circle done.");

  // Slow pass at 300 mm/min (5 mm/s): the pen dwells long enough at the four
  // diagonal belt-reversal points that backlash flat-spots become obvious.
  const runSlowCircle = () =>
    runProgram("Drawing 20 mm circle slowly (300 mm/min)…", circleGcode(300),
      "Slow circle done — inspect the four 45° points for flat spots.");

  // Draw at the board's configured max feedrate ($110) so the circle reflects
  // the actual top speed the current (tuned) settings allow, rather than a
  // fixed number. Reads $$ first; falls back to the power-on default if $110
  // can't be read.
  const runMaxCircle = () => {
    if (running) return;
    (async () => {
      const values = await connection.settings();
      const configuredMaxFeed = values["$110"];
      const feed = configuredMaxFeed > 0 ? configuredMaxFeed : CIRCLE_FEED_MM_MIN;
      if (!(configuredMaxFeed > 0)) {
        broadcast({ type: "log", text: `\n! Couldn't read $110; using ${CIRCLE_FEED_MM_MIN} mm/min.` });
      }
      runProgram(
        `Drawing 20 mm circle at configured max feed ($110 = ${Math.round(feed)} mm/min)…`,
        circleGcode(feed), "Circle done.");
    })().catch((err) => broadcast({ type: "log", text: `\n! Max-feed circle error: ${err.message}` }));
  };

  const runBacklash = () =>
    runProgram("Drawing backlash cross…", backlashGcode(),
      "Backlash cross done — a doubled line means lost motion on that belt.");

  // Release the steppers so the operator can push the toolhead by hand to a new
  // origin. Quick single command — no waitIdle, but still guarded so it can't
  // fire mid-program.
  const releaseMotors = () => {
    if (running) return;
    broadcast({ type: "log", text: "\nReleasing motors (M18) — move the toolhead by hand, then \"Enable & zero here\"." });
    connection.sendLine("M18", 5000)
      .catch((err) => broadcast({ type: "log", text: `\n! Release error: ${err.message}` }));
  };

  // Re-enable the steppers and make the current (hand-positioned) spot the new
  // origin. Pairs with releaseMotors() for a "hand-home" workflow.
  const zeroHere = () => {
    if (running) return;
    broadcast({ type: "log", text: "\nEnabling motors (M17) and zeroing here (G92 X0 Y0)…" });
    (async () => {
      await connection.sendLine("M17", 5000);
      await connection.sendLine("G92 X0 Y0", 5000);
    })()
      .then(() => broadcast({ type: "log", text: "Zeroed. This position is now X0 Y0." }))
      .catch((err) => broadcast({ type: "log", text: `\n! Zero error: ${err.message}` }));
  };

  // ───────── HTTP endpoints ─────────
  const server = http.createServer((req, res) => {
    const { method, url } = req;

    if (method === "GET" && url === "/") {
      serveFile(res, UI_FILE, "text/html");
      return;
    }

    if (method === "GET" && url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("\n");
      clients.add(res);
      res.write(
        `data: ${JSON.stringify({ type: "status", port: serialPath, running })}\n\n`
      );
      req.on("close", () => clients.delete(res));
      return;
    }

    if (method === "POST" && url === "/start") {
      readJson(req, (body) => {
        startSession(body.mode === "fine" ? "fine" : "coarse", body.tests || "CDAB");
        respondOk(res);
      });
      return;
    }

    if (method === "POST" && url === "/verdict") {
      readJson(req, (body) => {
        if (["y", "n", "r", "q"].includes(body.v)) submitVerdict(body.v);
        respondOk(res);
      });
      return;
    }

    if (method === "POST" && url === "/reset") {
      readJson(req, () => {
        resetDefaults();
        respondOk(res);
      });
      return;
    }

    if (method === "POST" && url === "/circle") {
      readJson(req, () => {
        runCircle();
        respondOk(res);
      });
      return;
    }

    if (method === "POST" && url === "/slow-circle") {
      readJson(req, () => {
        runSlowCircle();
        respondOk(res);
      });
      return;
    }

    if (method === "POST" && url === "/max-circle") {
      readJson(req, () => {
        runMaxCircle();
        respondOk(res);
      });
      return;
    }

    if (method === "POST" && url === "/backlash") {
      readJson(req, () => {
        runBacklash();
        respondOk(res);
      });
      return;
    }

    if (method === "POST" && url === "/release") {
      readJson(req, () => {
        releaseMotors();
        respondOk(res);
      });
      return;
    }

    if (method === "POST" && url === "/zero") {
      readJson(req, () => {
        zeroHere();
        respondOk(res);
      });
      return;
    }

    if (method === "POST" && url === "/stop") {
      readJson(req, () => {
        stopSession();
        respondOk(res);
      });
      return;
    }

    res.writeHead(404).end("Not found");
  });

  server.listen(httpPort, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${httpPort}`;
    console.log(`plotter-tune — serial ${serialPath} @ ${baud}`);
    console.log(`Open the tuner:  ${url}`);
    console.log("Ctrl+C here to quit.");
    openBrowser(url);
  });

  process.on("SIGINT", async () => {
    await connection.close();
    process.exit(0);
  });
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500).end(`Can't read ${path.basename(filePath)}`);
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function readJson(req, callback) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      callback(body ? JSON.parse(body) : {});
    } catch {
      callback({});
    }
  });
}

function respondOk(res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end('{"ok":true}');
}

/** Best-effort: open the default browser. Ignored if it fails (just use the URL). */
function openBrowser(url) {
  const opener =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(opener, () => {});
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
