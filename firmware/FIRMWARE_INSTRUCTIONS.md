# Custom Plotter Firmware — Setup Instructions

This firmware is the GRBL-compatible Blot firmware, adapted for a custom
plotter that uses **the same electronics** (Seeed XIAO RP2040 + A4988 drivers
+ servo pen-lift) but a **different CoreXY belt layout**. The only functional
change from stock is that the CoreXY motor-mixing is now selectable in
[`config.h`](config.h) so you can match your belt routing.

<sub>Based on [samdev-7/upgraded-blot](https://github.com/samdev-7/upgraded-blot), slightly modified for a selectable CoreXY belt layout.</sub>

There are three things to do, in order:

1. [Flash the firmware to the hardware](#1-flash-the-firmware-to-the-hardware)
2. [Select the CoreXY layout](#2-select-the-corexy-layout)
3. [Tune speed and acceleration](#3-tune-speed-and-acceleration)

Plus a reference section on [viewing, editing, and backing up
settings](#viewing-editing-and-backing-up-settings) (and whether they survive a
re-flash).

Reference docs: [`FIRMWARE.md`](FIRMWARE.md) (architecture),
[`SUPPORTED_COMMANDS.md`](SUPPORTED_COMMANDS.md) (G-code reference),
[`TUNING.md`](TUNING.md) (the theory behind tuning).

---

## 1. Flash the firmware to the hardware

1. Install the [Arduino IDE](https://www.arduino.cc/en/software).
2. Open **Arduino → Settings** and, under _Additional boards manager URLs_,
   paste:
   `https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json`
3. Open **Tools → Board → Boards Manager**, search `pico`, and install
   **Raspberry Pi Pico/RP2040** by Earle F. Philhower.
4. Select the board: **Tools → Board → Raspberry Pi Pico/RP2040 → Seeed XIAO
   RP2040**.
5. Open the sketch: **File → Open → `firmware/firmware.ino`**. The IDE picks up
   the other `.cpp`/`.h` files in this folder automatically.
6. Plug the plotter into USB. Under **Tools → Port**, pick the
   `/dev/cu.usbmodem…` (macOS) / `COMx` (Windows) entry that appears.
7. Click the **upload arrow** (top-left). Wait for **"Done uploading."**
8. Sanity-check the board is alive: open a serial terminal at **115200 baud**
   (or run [`tools/term.py`](tools/term.py)) and send `?`. You should get back
   something like `<Idle|MPos:0.000,0.000|FS:0,0>`. Send `$I` — it should
   report a Grbl version string.

> If nothing shows up on the port, double-tap the XIAO's reset to enter
> bootloader mode, then re-select the port and upload again.

---

## 2. Select the CoreXY layout

Because this plotter's belts are routed differently from stock Blot, you have
to tell the firmware which motor-mixing matches your machine. This is a single
number — `COREXY_LAYOUT` — in [`config.h`](config.h). You find the right value
with a quick bench test: try a layout, jog the carriage, watch which way it
actually moves, and reflash if it's wrong.

**Do this with the pen UP and off the paper** so a wrong guess just scoots the
carriage around harmlessly. Keep a hand near the USB cable / reset in case the
carriage heads for an end-stop.

1. In [`config.h`](config.h), leave `COREXY_LAYOUT` at its default of `1` for
   the first attempt. Flash the firmware (Section 1).
2. Connect a terminal at 115200 baud ([`tools/term.py`](tools/term.py) or any
   G-code sender).
3. Enable the motors and set a temporary origin:
   ```
   M17
   G21 G90
   G92 X0 Y0
   ```
4. Command a small **+X** move and watch the carriage, then send it back:
   ```
   G1 X20 F1000
   G1 X0
   ```
5. Command a small **+Y** move and send it back:
   ```
   G1 Y20 F1000
   G1 Y0
   ```
6. Judge what you saw against the target: **+X should move the carriage
   straight to the RIGHT, +Y straight AWAY from you (up the page)**, and both
   moves should be clean horizontal/vertical lines.
   - **Correct** (cardinal + right directions) → you're done; keep this
     `COREXY_LAYOUT`.
   - **Diagonal motion** for a straight X or Y command → the belt-mix is wrong.
     Change `COREXY_LAYOUT` to the next value, reflash, and repeat from step 3.
   - **Straight but mirrored** (X goes left, and/or Y comes toward you) → try
     the other layouts first; if none give the right directions, flip the
     offending motor's `DIR` connector (or negate that motor's row in
     `config.h`).
7. Work through `COREXY_LAYOUT = 1, 2, 3, 4`, reflashing each time, until a
   layout passes step 6.
8. Confirm with a diagonal: `G1 X20 Y20 F1000` then `G1 X0 Y0` should trace a
   clean **45° line**, not a staircase or an axis-aligned move.
9. When finished, disable the motors: `M18`.

> The four presets are the four physically distinct CoreXY belt routings — see
> the comment block in [`config.h`](config.h) for the exact motor-mixing
> equations each one uses. Only one will match your machine.

---

## 3. Tune speed and acceleration

The firmware ships with conservative speed/accel caps so a freshly assembled
machine won't skip steps. Tuning pushes those caps up to what your specific
belts and motors can handle, then backs off to a safety margin. The guided
script [`tools/tune.py`](tools/tune.py) automates the whole procedure; the
theory behind it is in [`TUNING.md`](TUNING.md).

**What it tunes** (four numbers, because CoreXY loads the motors differently on
axes vs. diagonals):

| Setting | What it caps                         | Tuned by      |
| ------- | ------------------------------------ | ------------- |
| `$110`  | Max tip feedrate (mm/min)            | axis test     |
| `$112`  | Max individual-motor rate (mm/min)   | diagonal test |
| `$120`  | Max tip acceleration (mm/s²)         | axis test     |
| `$122`  | Max individual-motor accel (mm/s²)   | diagonal test |

The script writes these to flash so they persist across power cycles. It does
**not** touch `$100` (steps/mm) or the servo pen settings — those are physical
calibration, set with a ruler, not this script.

**Run it:**

1. Install `pyserial` once: `pip3 install pyserial`.
2. Put a pen in the holder with the tip touching taped-down paper. Leave
   ~120 mm of free travel in **+X** and **+Y** (the tests use 100 mm on axes
   and ~71 mm on diagonals).
3. Close anything else that owns the USB port (a G-code sender, the terminal).
4. Run the coarse tune from the repo root:
   ```bash
   python3 firmware/tools/tune.py
   python3 firmware/tools/tune.py --port /dev/cu.usbmodemXXXX   # if auto-port is wrong
   ```
5. The script marks an origin dot, then walks through four tests in order
   **C → D → A → B** (accel first, then speed). For each iteration it runs a
   short pattern that should return the pen to the origin dot.
6. After each pattern, answer the prompt:
   - `y` — pen came back cleanly to the dot, no grinding noise → it steps up
     and tries a faster/harder value.
   - `n` — pen drifted off the dot, or you heard the motor grind/stall → it
     backs off to a safe fraction of the last good value and saves it.
   - `r` — retry the same value. `q` — stop this test.
7. When all four tests finish, the script writes the tuned values (and derives
   `$111` rapid rate) to flash and prints a summary.
8. Optional: run a fine pass to land closer to the real limit:
   ```bash
   python3 firmware/tools/tune.py --fine
   ```
   `--fine` starts just below your stored values and steps in smaller
   increments. You can also tune a single pair, e.g. `--tests CA` for axis
   accel + axis speed only.

> **How to read the pen:** the firmware's `MPos:` counter tracks commanded
> pulses, not real rotation, so it can't tell you when a motor skipped — you
> have to look. A visible drift from the origin dot, or an audible grindy/clacky
> noise during a move, both mean answer `n`.

---

## Viewing, editing, and backing up settings

All the tunable values (speeds, accels, work area, servo pulse widths) live in
flash on the board and are read/written over serial with standard GRBL `$`
commands. Connect at 115200 baud with [`tools/term.py`](tools/term.py), any
G-code sender, or UGS's **Firmware Settings** panel.

**View everything currently on the plotter** — send `$$`. The real dump also
includes GRBL-compatibility stub lines (`$0`–`$32`, plus `$101`/`$121` Y-axis
mirrors) that senders expect; the meaningful ones for this plotter are below
(the descriptions are added here for clarity — the firmware prints just
`$id=value`):

```
$100=80.000     steps/mm (fixed; set by hardware, not tunable here)
$110=3000.000   max tip feedrate (mm/min)
$111=3000.000   max rapid/travel feedrate (mm/min)
$112=4000.000   max individual-motor rate (mm/min)
$120=800.000    max tip acceleration (mm/s²)
$122=1000.000   max individual-motor accel (mm/s²)
$130=125.000    work area X (mm)
$131=125.000    work area Y (mm)
$140=0.050      junction deviation (mm)
$141=0.002      arc tolerance (mm)
$150=1000       servo pen-up (µs)
$151=1700       servo pen-down (µs)
```

**Edit one value** — send `$<id>=<value>`, e.g. `$110=3500` or `$151=1650`. The
change takes effect immediately and is saved to flash automatically a moment
later (writes are debounced and only happen while the motors are idle, so a
burst of edits won't stall motion).

**Reset everything to firmware defaults** — send `$RST=*`.

> The CoreXY layout (Section 2) is **not** one of these settings — it's a
> compile-time `#define` in [`config.h`](config.h), so changing it requires an
> edit + re-flash, not a `$` command.

### Do settings survive a firmware re-flash?

- **Power cycles: always.** Settings are in flash, not RAM. Turning the plotter
  off and on keeps them.
- **A normal re-flash: usually, but not guaranteed.** The settings blob lives in
  a flash region separate from the program, so uploading a new sketch normally
  leaves it intact. It gets **wiped/ignored** if any of these happen:
  - You do a full-chip erase (e.g. `flash_nuke.uf2`, or a "erase all flash"
    option in the uploader).
  - The new firmware changes the settings struct — the firmware bumps an
    internal version stamp and treats an old, mismatched blob as invalid,
    falling back to defaults.
  - You change the flash or filesystem size in the Arduino IDE, which moves
    where the settings region lives.

**Bulletproof workflow: back up before you re-flash.**

1. Before flashing, connect and send `$$`. Copy the output somewhere safe (or
   run `python3 firmware/tools/term.py` and save the log).
2. Re-flash the firmware.
3. Send `$$` again to see what carried over.
4. Re-apply anything that reset by sending the `$<id>=<value>` lines from your
   backup (only the values that differ from the new defaults). Pasting the
   whole saved block back in also works — the firmware just ignores the
   read-only lines like `$100`.

> Re-running [`tools/tune.py`](tools/tune.py) also re-derives the speed/accel
> caps from scratch, so if you only re-flash occasionally, a quick `--fine`
> pass is another way to restore them.
