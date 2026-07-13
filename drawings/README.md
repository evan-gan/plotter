# drawings/

Community gallery for the plotter. **Add your drawing here via a pull
request** — once merged (and the Pi pulls), it shows up in the web gallery
with a computed plot-time estimate, and anyone can queue it.

Rules of thumb:

- `.svg` files: line art only. Strokes are plotted as pen lines; fills are
  ignored (outlines get drawn). Convert text to paths first. The drawing is
  auto-scaled to fit the plotter's work area and path-optimized on the server.
- `.gcode` files: streamed as-is (no re-optimization), so they must already
  target this machine (GRBL subset, `M3`/`M5` pen, mm, see
  `firmware/SUPPORTED_COMMANDS.md`).
- Give files readable kebab-case names — `tessellating-ducks.svg` becomes
  "tessellating ducks" in the gallery.
