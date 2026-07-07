# Custom Plotter — Project Index

A custom 2-axis CoreXY pen plotter. It reuses the **stock Blot electronics**
(Seeed XIAO RP2040 + A4988 stepper drivers + servo pen-lift) but has a
**different CoreXY belt layout**, so the firmware's motor-mixing is selectable.

This repo currently contains hardware notes and the firmware. The firmware is a
GRBL-protocol-compatible G-code firmware based on
[samdev-7/upgraded-blot](https://github.com/samdev-7/upgraded-blot) (a fork of
Hack Club's Blot), slightly modified for a selectable CoreXY belt layout. The
`upgraded-blot-main/` folder is the reference source it was adapted from (kept
in-tree, git-ignored).

## Top-level layout

```
firmware/            ← THE firmware for this plotter (flash this). See below.
upgraded-blot-main/  ← Reference fork it was adapted from (git-ignored). Also
                       contains a Mac desktop UI in ui/ — not used here.
photos/              ← Build photos.
BOM.md               ← Bill of materials.
Journal.md, TODO.md  ← Build log and task list.
README.md            ← Repo overview.
```

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
- `TUNING.md` — the theory behind `tune.py`.

### `firmware/tools/`
- `term.py` — raw serial REPL.
- `stream.py` — file-based G-code streamer with flow control.
- `tune.py` — guided speed/accel calibration (tunes `$110`/`$112`/`$120`/`$122`).

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
