# Custom Plotter — Project Index

A custom 2-axis CoreXY pen plotter. It reuses the **stock Blot electronics**
(Seeed XIAO RP2040 + A4988 stepper drivers + servo pen-lift) but has a
**different CoreXY belt layout**, so the firmware's motor-mixing is selectable.

This repo contains hardware notes, the firmware, and the **`software/` web
stack** (queue/gallery site + Pi backend + SVG optimizer). The firmware is a
GRBL-protocol-compatible G-code firmware based on
[samdev-7/upgraded-blot](https://github.com/samdev-7/upgraded-blot) (a fork of
Hack Club's Blot), slightly modified for a selectable CoreXY belt layout. The
`upgraded-blot-main/` folder is the reference source it was adapted from (kept
in-tree, git-ignored).

## Top-level layout

```
firmware/            ← THE firmware for this plotter (flash this). See below.
software/            ← Web stack: SVG optimizer + Pi server + Svelte UX. See below.
drawings/            ← Community gallery drawings (added via GitHub PRs).
upgraded-blot-main/  ← Reference fork it was adapted from (git-ignored). Also
                       contains a Mac desktop UI in ui/ — not used here.
photos/              ← Build photos.
BOM.md               ← Bill of materials.
Journal.md, TODO.md  ← Build log and task list.
README.md            ← Repo overview.
```

## `software/` — the web stack (pnpm workspace, TS + Svelte, no frameworks)

Three packages. **Run everything locally with `cd software && pnpm install &&
pnpm local`** (builds, then serves the backend against a built-in firmware
*simulator* + the Vite dev frontend — no hardware needed). `pnpm local:real`
uses a real board. `pnpm test` runs the utils + backend suites. Full details in
`software/README.md`.

### `software/utils/` — pure-TS library (no deps): converters + optimizer
| File | What it does |
| ---- | ------------ |
| `src/types.ts` | `Point`/`Polyline`/`Drawing`, distance + pen-up-distance + bbox helpers. |
| `src/kd-tree.ts`, `src/union-find.ts` | 2-D k-d tree (radius + k-NN) and disjoint-set — the optimizer's spatial + connectivity primitives. |
| `src/svg-path.ts` | SVG `<path d>` parser + bezier/arc flattening (recursive subdivision). |
| `src/svg-parse.ts` | Whole SVG document → `Drawing` (shapes, nested transforms, defs-skipping, Y-flip + work-area fit). |
| `src/svg-generate.ts` | `Drawing` → preview SVG (used by gallery/queue/submit thumbnails). |
| `src/gcode-parse.ts`, `src/gcode-generate.ts` | G-code ⇄ `Drawing` (pen-aware; mirrors firmware modal state + arc chord math). `gcode-generate` also exports `retargetDrawFeed()` (rewrite an already-generated program's draw feed, guarded by `GENERATED_MARKER`) — used by the backend's refeed. |
| `src/intersections.ts` | **Crossing-breakpoint pre-stage** for the optimizer: `splitPolylinesAtIntersections` finds every point where polylines cross each other or themselves (grid-accelerated segment intersection, not O(n²)) and splits the polylines there, so crossings become shared endpoints the tour can route *through*. Ink is unchanged (a split only adds a collinear vertex). Also exports `segmentIntersection`. |
| `src/optimizer.ts` | **The path optimizer** (TODO.md algorithm): (optional crossing-split via `intersections.ts`) → endpoint merge → greedy chaining → greedy tour → alternating 2-opt/Or-opt → orientation DP. Minimizes pen-up distance. `OptimizeOptions.splitAtIntersections` (default **on**) enables the crossing-split pre-stage; the optimizer plans the tour both with and without splitting and keeps whichever scores lower (pen-up + per-lift penalty), so splitting can never regress a plot. `stats.splitAtIntersectionsApplied` reports whether the split plan won. |
| `src/pipeline.ts` | One-call `prepareSvgPlot` / `prepareGcodePlot` → `{gcode, previewSvg, stats}`. |
| `src/index.ts` | Public barrel. `tests/` = plain-JS harness over `dist/` (`pnpm test`, 47 checks). |

### `software/backend/` — the Raspberry Pi server (node:http, no framework)
Serial is **optional**: it runs disconnected and swaps in a firmware simulator
when `PLOTTER_SIMULATE=1`. Reuses `firmware/tools/lib` for ETA/tuning/calibration.
| File | What it does |
| ---- | ------------ |
| `src/server.ts` | Entry point: declarative route table over node:http; public + admin API; SSE; static hosting of the frontend build. `buildServices()` wires everything. On startup `main()` kicks off `gallery.refreshAll()` in the background (after connecting the simulated board so the tuned feed is used) to recompute every drawing's SVG→G-code from scratch. |
| `src/config.ts` | All config from env vars (`ADMIN_PASSWORD`, `PLOTTER_SIMULATE`, `PORT`, `GALLERY_DIR`, `WORK_W/H_MM`, …). Finds the repo root. |
| `src/connection.ts` | GRBL-protocol logic (ok/error, `?` status, `$$`, waitIdle), transport-agnostic base class. |
| `src/serial-connection.ts` | Real USB-serial transport (lazy-loads `serialport`). |
| `src/simulated-connection.ts` | **Built-in firmware simulator**: motion timeline, `?`/`!`/`~`/soft-reset, `$$`/`$N=`, pen dwell. Lets the whole stack run with no hardware. |
| `src/serial-manager.ts` | Owns the single (optional) connection; connect-on-demand, drop/reconnect. |
| `src/machine-lock.ts` | One mutex over everything that commands motion (runner/tuner/jog/shapes). |
| `src/queue.ts` | Drawing queue + JSON DB (`data/queue.json` + per-job gcode/preview files), reorder, crash recovery. |
| `src/runner.ts` | `PlotRunner`: streams a job with ok/error flow control; realtime pause/resume/abort (soft-reset). |
| `src/machine.ts` | Jog, set-home, steppers, pen, settings read/write, `$RST=*`, diagnostic shapes. |
| `src/tuner.ts` | Bridges `firmware/tools/lib` tune-engine + calibrate harness onto SSE (`tune:*`/`cal:*` events). |
| `src/eta.ts` | ETA wrapper: firmware ETA engine + live `$$` + host calibration knobs. |
| `src/gallery.ts` | `drawings/` folder → previews + ETAs, cached by mtime. `refreshAll()` force-clears the cache and reprocesses every drawing — called once at server startup (from `server.ts` `main()`) so gallery G-code always reflects the current optimizer/generator code after a deploy, not a stale cached result. **Enqueuing a gallery pick is treated exactly like a fresh upload:** the `/api/gallery/:id/enqueue` route calls `readSource(id)` to read the *original* `drawings/` file and re-prepares it through `SubmissionService` at enqueue time (SVG re-optimized, authored G-code streamed as-is), so the queued job's G-code + ETA use the board's *current* tuned feed and the latest optimizer — never a cached result. Only the preview SVG is cached to disk (the ETA in the list view is computed in-memory), so cached G-code is no longer written. |
| `src/submissions.ts` | SVG/G-code in → optimized gcode + preview + ETA (drives `/api/estimate` + `/api/submit`). Generated draw (G1) strokes use the board's tuned max feed (`$110`, via `EtaService.liveMaxFeedMmMin()`), falling back to `DRAW_FEED_MM_MIN` (default 1500) when offline — so plots draw at the tuned speed, not the generator default. Same for gallery SVGs in `gallery.ts`. |
| `src/refeed.ts` | `PlotRefeedService`: after the board is retuned / ETA-calibrated / a motion setting ($110-$122) is changed, rewrites the draw feed of already-queued jobs (and drops the gallery cache) to the board's *current* tuned `$110` and refreshes their ETAs. Only touches gcode we generated (identified by `GENERATED_MARKER` via `utils`' `retargetDrawFeed`); authored gcode is left byte-for-byte. Wired into `tuner.ts` (tune-complete + save-calibration), `machine.ts` (setSetting/resetDefaults), and `POST /api/admin/refeed`. No-op when no board is reachable (won't guess a feed). **Why this exists:** the firmware caps each move at `min($110, $112/motor-load)`, so a plot generated with a low `F` word draws slowly *even on a tuned board* — the ETA is accurate but the speed is left on the table. Refeeding lifts existing jobs to the tuned rate. |
| `src/events.ts`, `src/http-util.ts`, `src/db.ts`, `src/firmware-bridge.ts` | SSE bus; HTTP helpers (JSON, admin-password check, static serving); atomic JSON store; typed `require()` bridge to `firmware/tools/lib`. |
| `tests/` | HTTP + runner + queue + eta + refeed suites against the simulator (`pnpm test`, 23 checks). |

### `software/frontend/` — static Svelte 5 + Vite SPA
Hash-routed, talks to the backend over `/api` (proxied in dev, same-origin in
prod). `src/pages/` = Home (GitHub-upload instructions), Submit (optimize +
estimate), Queue, Gallery (ETAs), Admin (password-gated). `src/components/` =
reusable pieces incl. the **componentized** `MachineControls`/`JogPad`,
`TunerPanel`, `CalibrationPanel`, `SettingsTable`, `PlotControls`,
`QueueManager`, `ConsoleLog`. `src/lib/` = `api.ts` (typed client), `stores.ts`
(SSE fan-out), `router.ts`, `format.ts`. Tokens in `src/app.css`.

> Svelte gotcha learned here: a `$:` auto-scroll effect that both reads and
> reassigns a variable its own scroll handler sets is an infinite loop that
> **freezes silently in production builds** (the dev-only "max update depth"
> error is stripped). `ConsoleLog.svelte` uses `afterUpdate` + change-guards
> instead. Verify UI changes in a real browser, not just `pnpm build`.

Not yet built (TODO.md): camera / paper-alignment vision.

## `firmware/` — where to make changes

Arduino sketch for the XIAO RP2040. Open `firmware.ino` in the Arduino IDE
(arduino-pico core, board = Seeed XIAO RP2040). All `.cpp`/`.h` compile as one
sketch. GRBL-subset protocol at 115200 baud; pen maps onto spindle commands
(`M3 S<µs>` = pen down, `M5` = pen up).

| File | What it does |
| ---- | ------------ |
| `firmware.ino` | Entry point: `setup()`/`loop()`. Wires up settings, planner, stepper, gcode, protocol. |
| `config.h` | **Pins, mechanical constants, defaults, and the `COREXY_LAYOUT` selector.** Change the CoreXY belt layout (1–4) here. |
| `kinematics.h` | CoreXY forward/inverse kinematics + motor-load factor. Layout-parameterized via the `COREXY_*` macros from `config.h`; general 2×2 matrix inverse so all four layouts round-trip. **This is the file that differs from stock Blot.** |
| `planner.cpp/.h` | Look-ahead motion planner: ring buffer, trapezoidal profiles, junction deviation, CoreXY-aware per-block accel/speed clamping. Layout-agnostic (works through `kinematics.h`). |
| `stepper.cpp/.h` | Hardware-timer step ISR; Bresenham mixing between the two motors; realtime feed hold / resume. |
| `gcode.cpp/.h` | G-code parser + executor (G0–G4, G20/21, G90/91, G92, G28, M-codes, `$` settings). |
| `arc.cpp/.h` | On-device G2/G3 arc interpolation (I/J or R). |
| `protocol.cpp/.h` | Serial line buffering, `ok`/`error:N` flow control, realtime bytes (`?`/`!`/`~`/soft-reset). |
| `settings.cpp/.h` | `$$`/`$N=` runtime settings, persisted to flash. |

### Docs in `firmware/`
- `FIRMWARE_INSTRUCTIONS.md` — **numbered steps to flash, select the CoreXY layout, and tune.** Start here for setup.
- `FIRMWARE.md` — architecture / design rationale.
- `SUPPORTED_COMMANDS.md` — exact G-code/command reference.
- `TUNING.md` — the theory behind the tuner.

### `firmware/tools/` — Node/pnpm serial tools
A self-contained pnpm project (pnpm is scoped to this folder). One dependency:
`serialport`. Run `pnpm install` once, then `pnpm <script>` from here (or
`pnpm --dir firmware/tools <script>` from the repo root). All auto-detect the
plotter's USB serial port; `--port` overrides.

| File | What it does |
| ---- | ------------ |
| `lib/serial.js` | Shared serial helper: port autodetect (`tty.`→`cu.` on macOS), line reader, `sendLine`→ok/error, `?` status, `$$` settings parse, arg parser. |
| `lib/tune-engine.js` | Transport-agnostic tuning state machine (ported from the old `tune.py`): the four tests (C/D/A/B), CoreXY push/pull of cross-constraints, backoff math. Driven through an `io` object. |
| `lib/gcode-parser.js` | Parses a `.gcode` file into modal-state-free motion primitives (move/pen/dwell) for the ETA engine. Resolves G20/21, G90/91, G92, modal F/motion-mode; flattens G2/G3 arcs with the **same chord formula as `arc.cpp`** so segment counts match hardware. Emits mm / mm-min / ms. |
| `lib/eta-engine.js` | Transport-agnostic ETA estimator. Replicates the firmware motion model offline: CoreXY motor-load caps (`kinematics.h`), per-block speed/accel clamping + junction-deviation corners + backward/forward look-ahead (`planner.cpp`), trapezoidal per-block time + fixed pen dwell (`stepper.cpp`). Motor-load factor is layout-independent, so it works for any `COREXY_LAYOUT`. `configFromSettings()` maps a `$$` dump onto its config; `DEFAULT_CONFIG` holds the compile-time fallbacks. Applies three **calibration knobs** — `motionScaler`, `overheadPerMoveMs`, `penMoveMs` (identity by default). Treats the 16-block buffer as unbounded (accurate for pre-buffered files). |
| `lib/calibrate.js` | Transport-agnostic **ETA calibration harness**. Runs 5 distinct action types (straight X line, 45° diagonal, dense zigzag, circle, pen-lift cycles) at the board's stored feed, times each on-machine (`timeProgram`), and least-squares-fits (`leastSquares2` → `deriveCalibration`) the three knobs: `motionScaler`/`overheadPerMoveMs` from the pen-up motion tests, `penMoveMs` from the pen test. Driven through an `io` object (log/result/summary). Motion tests run pen-up (no ink). |
| `lib/calibration-store.js` | Load/save the fitted knobs to `firmware/tools/eta-calibration.json` **on the host computer — NOT the plotter flash**. `loadCalibration()`/`saveCalibration()`. Stores only the ETA correction knobs, never `$$` (those are always read live off the board). |
| `term.js` | `pnpm term` — interactive serial REPL / monitor (raw-mode input). |
| `stream.js` | `pnpm stream <file.gcode>` — G-code file streamer with ok/error flow control. |
| `eta.js` | `pnpm eta <file.gcode>` — prints an estimated plot time + breakdown (segment count, draw/travel distance, pen lifts, motion/overhead/fixed time). Reads **live** config off the board via `$$` by default; auto-applies a saved `eta-calibration.json`. Flags: `--offline` (firmware defaults, no serial), `--port`, `--pen-ms`, `--scaler` (motion multiplier), `--overhead-ms` (per-move), `--no-calibration`. |
| `calibrate.js` | `pnpm calibrate` — runs `lib/calibrate.js` on the connected board and prints an estimate-vs-actual table + suggested scalers. `--save` writes them to `eta-calibration.json`; `--repeats N`, `--port`. Pen stays up (no ink); clear ~80 mm of +X/+Y travel. |
| `eta-calibration.json` | **Host-side file at `firmware/tools/eta-calibration.json` (lives on the computer, NOT on the plotter).** Generated by `pnpm calibrate --save` (or the tuner's **Save scalers** button). Holds the three ETA correction knobs + a `savedAt`/`note`. Machine-specific; `eta.js`/tuner load it automatically. Deleting it just reverts to the raw physics estimate. |
| `tune.js` | `pnpm tune` — HTTP + SSE server that serves the tuning page and bridges it to the serial port. Runs the engine; browser is the control surface. Shape/diagnostic endpoints stream G-code via a shared `runProgram()` helper: `POST /circle` (20 mm test circle at an explicit 750 mm/min, on-device G2 arc), `POST /slow-circle` (same at 300 mm/min to expose backlash flat-spots), `POST /max-circle` (reads `$110` and draws at the board's configured max feedrate), `POST /backlash` (four out-and-back strokes from one centre — cardinal + diagonal — to reveal per-belt lost motion). ETA calibration: `POST /calibrate` (runs `lib/calibrate.js`, streaming `calStart`/`calRow`/`calSummary` events) + `POST /save-calibration` (persists the last run's knobs). Note: each circle sets its own `F` word because feedrate is modal on the board, so one button can't leave a stale feed that changes another's speed. Positioning: `POST /release` (`M18`, hand-move the head) + `POST /zero` (`M17`+`G92 X0 Y0`). `POST /reset` restores firmware defaults via `$RST=*`. |
| `tune-ui.html` | The single-page tuning UI (vanilla JS, no build step) served by `tune.js`. "Test shapes & diagnostics" panel: **Draw 20 mm circle**, **Draw circle slowly**, **Draw circle at max feed**, **Draw backlash cross**. "ETA calibration" panel: **Run ETA calibration** (per-action estimate/actual/ratio table + fitted knobs) + **Save scalers**. "Positioning" panel: **Release motors** + **Enable & zero here** (hand-home workflow). **Reset to defaults** (with confirm) lives in the settings section. |
| `patterns/` | Sample `.gcode` files for `stream.js`. |
| `test/run_all.js` | `pnpm test` — host-side tests for the parser + ETA engine + calibration math (no serial/hardware). Analytic trapezoid/motor-load cases, parse checks, least-squares/knob-recovery, and a mock-clock `timeProgram` test. 19 tests. |

These replaced the original Python (`term.py`/`stream.py`/`tune.py` + pyserial).

### `firmware/test/`
Host-side C++ test harness (mocks `<Arduino.h>`). Run with `cd firmware/test && make test`.
161 tests as of last change. `test_kinematics.cpp` covers the CoreXY math.
`firmware/test_gcode/` holds sample G-code programs for integration tests.

## Key design fact: CoreXY layout selection

The one substantive difference from stock Blot lives in `config.h` +
`kinematics.h`. `COREXY_LAYOUT` (1–4) picks the sign matrix for
`cartesian_to_motor`; layout `1` is the stock-Blot routing (default), the other
three are the remaining physically distinct belt routings. The rest of the
firmware never sees the layout — it only calls the three functions in
`kinematics.h`. Which layout is correct is determined by the bench test in
`FIRMWARE_INSTRUCTIONS.md`.

## Key design fact: two separate settings stores (board vs. host)

There are **two** places settings live, and they must not be confused:

1. **Plotter flash** — the motion config (`$110` feed, `$120` accel, servo
   pulses, …). Written by `$N=` / the tuner / `$RST=*`; persisted in EEPROM
   emulation by `settings.cpp`. This is what the firmware actually runs on.
2. **Host file `firmware/tools/eta-calibration.json`** — the ETA *estimator's*
   three correction knobs (`motionScaler`, `overheadPerMoveMs`, `penMoveMs`).
   Written by `pnpm calibrate --save` or the tuner's **Save scalers** button.
   **This lives on the computer, never on the plotter.**

The calibration tool *reads* store #1 live (via `$$`) every run so estimates
track current tuning, but *writes* only to store #2. "Save scalers" does NOT
touch the plotter. If board settings change, re-run `pnpm calibrate`.
