# software/

The plotter's software stack — a pnpm workspace with three packages:

| Package | What it is |
| ------- | ---------- |
| [`utils/`](utils) | Pure-TS library: SVG ⇄ G-code converters and the pen-up path optimizer (endpoint merge → chaining → greedy tour → 2-opt/Or-opt). No runtime deps. |
| [`backend/`](backend) | The Raspberry Pi server (node:http, no framework). Drawing queue + JSON DB, G-code runner with pause/abort, machine controls, tuning + ETA-calibration bridge, SSE events, static hosting of the frontend. Serial is **optional** — it runs disconnected, and ships a built-in firmware simulator. |
| [`frontend/`](frontend) | Static Svelte 5 + Vite SPA: GitHub-upload instructions, send-a-drawing (optimize + time estimate), live queue, gallery with ETAs, and the password-gated admin panel (start/pause/abort, reorder, jog/home/steppers, componentized tuner + calibration + settings). |

## Quick start (no hardware needed)

```bash
cd software
pnpm install
pnpm local          # builds, then runs backend (SIMULATED plotter) + frontend dev server
# frontend: http://localhost:5173   admin password: "local"
```

`pnpm local:real` (or setting `PLOTTER_SERIAL=/dev/...`) uses the real board
instead of the simulator.

## Tests

```bash
cd software && pnpm test    # runs utils + backend suites (no hardware)
```

## Deploying on the Pi

```bash
cd software
pnpm install
pnpm build                                  # builds all three packages
ADMIN_PASSWORD=«secret» pnpm --filter plotter-backend start
```

The backend serves the built frontend itself, so the Pi is the whole website:
`http://«pi»:5180`. Environment knobs (all optional except the password):

| Var | Default | Meaning |
| --- | ------- | ------- |
| `ADMIN_PASSWORD` | *(unset — admin API disabled)* | Password for the admin panel. |
| `PORT` / `HOST` | `5180` / `0.0.0.0` | HTTP bind. |
| `PLOTTER_SERIAL` | auto-detect | Serial device path. |
| `PLOTTER_SIMULATE` | off | `1` = built-in firmware simulator instead of hardware. |
| `DATA_DIR` | `software/backend/data` | Queue DB + job files. |
| `GALLERY_DIR` | `<repo>/drawings` | Gallery source folder (PR'd drawings). |
| `WORK_W_MM` / `WORK_H_MM` | `120` / `120` | Work area uploads are scaled to fit. |
| `DRAW_FEED_MM_MIN` | `1500` | **Fallback** pen-down draw feed. At runtime the board's tuned `$110` is used instead; this only applies when no board is reachable. |
| `STATIC_DIR` | `software/frontend/dist` | Frontend build to serve. |

Two settings stores, same rule as the firmware tools: motion settings live on
the **board** ($$ / settings panel); the ETA estimator's calibration knobs live
on the **host** in `firmware/tools/eta-calibration.json` (written by the admin
panel's "Save scalers" or `pnpm calibrate --save`).

Camera features from the TODO (plot monitoring / paper alignment) are not
implemented yet — see TODO.md "Later".
