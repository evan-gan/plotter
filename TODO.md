# Active:
- Camera (big ifs, last to implement if time) — NOT DONE
  - Use camera to determine if it's working?
  - Paper alignment finding (need to figure out how the camera figures out where the plotter is relative to it)

# Later:
- Vision paper recognition?

# Done (software stack — see software/README.md + .claude/CLAUDE.md):
- UTILS (`software/utils`):
  - ~~Path optimizer (SVG)~~ — endpoint merge (k-d tree + union-find) → greedy
    chaining → greedy tour → alternating 2-opt/Or-opt, orientation DP. Exactly
    the algorithm below. Pen-up distance only.
  - ~~GCODE -> SVG and SVG -> GCODE converters~~ — full SVG path/shape/transform
    parser + curve flattening; G-code parse/generate; preview SVG generation.
  - ~~Time estimator~~ — reuses firmware/tools' ETA engine via the backend.
- User facing frontend UX (`software/frontend`, TS + Svelte 5, no framework):
  - ~~Upload drawing on github instructions~~ (Home page)
  - ~~Send custom drawing (SVG) + optimize & estimate~~ (Submit page)
  - ~~Drawing queue~~ (Queue page)
  - ~~Gallery w/ pick option + computed ETAs~~ (Gallery page)
  - ~~Admin panel (env password): start/pause/abort, reorder queue, jog, set
    home, enable/disable steppers, componentized tuner + ETA calibration + test
    shapes + settings~~ (Admin page + components/)
- Raspberry Pi server (`software/backend`, node:http, no framework):
  - ~~Receive + run GCODE~~ (queue + runner, with pause/resume/abort)
  - ~~Acts as DB (JSON files) + serves the static frontend~~
  - Optional serial: runs disconnected, ships a firmware simulator.

Original optimizer spec (implemented):
  - Merge all path endpoints within a customizable tolerance (default 0.3mm) using a k-d tree or spatial hash, then greedily chain paths sharing snapped endpoints into continuous polylines to eliminate pen lifts; represent each remaining polyline as a node with two endpoints and mutable orientation, compute inter-node cost as the minimum Euclidean pen-up distance across all four endpoint pairings (reversal is free), build an initial tour via greedy edge matching (sort candidate connections by length, add cheapest first, reject any move creating degree-3 nodes or premature subtours using union-find, restricting candidates to each node's ~10 nearest neighbors via k-d tree for scalability), then improve to a local optimum by alternating 2-opt (reverse a tour segment, accept only if shorter) and Or-opt (relocate runs of 1 to 3 consecutive nodes elsewhere, trying both orientations of the lifted run) using neighbor lists rather than all-pairs scans, iterating until no improving move exists; optimize pen-up distance only, since once the path set is fixed the pen-lift-count term is constant and distance ranks tours identically to time.

# Done:
- PLA PETG for supports - Bought!
- ~~CAD ALL BOLTS!!!~~ (kinda abandoned. vibes I guess. for what it's worth I did count)
- ~~Use 1 length m5 bolt~~ time constraints + long bolts made this a no no
- Motion system, then toolhead
- Tool head servo + belt mounting
- ~~RUBBER BAND FOR UP MECHANISM!!~~ Ran out of time
- Fix stepper holes for shorter screws
- Fix hex nut holes to be round depths
