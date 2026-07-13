<script lang="ts">
  import { navigate } from "../lib/router";
</script>

<section class="card hero">
  <h1>Pen plotter, at your service</h1>
  <p class="muted">
    A custom CoreXY pen plotter. Send it an SVG and it draws the thing — paths
    get automatically merged, reordered and time-estimated before they hit paper.
  </p>
  <div class="actions">
    <button class="primary" on:click={() => navigate("submit")}>Send a drawing</button>
    <button on:click={() => navigate("gallery")}>Browse the gallery</button>
  </div>
</section>

<section class="card">
  <h2>Add your drawing on GitHub</h2>
  <p>
    Want your drawing in the shared gallery so anyone can plot it? Submit it
    through GitHub — that's also the way to go if the plotter is offline right
    now:
  </p>
  <ol>
    <li>
      Fork the repo:
      <a href="https://github.com/evan-gan/plotter" target="_blank" rel="noreferrer">
        github.com/evan-gan/plotter</a>.
    </li>
    <li>
      Add your <code>.svg</code> (or ready-made <code>.gcode</code>) file to the
      <code>drawings/</code> folder. Keep it line art — fills and strokes are
      plotted as outlines, text isn't supported (convert text to paths first).
    </li>
    <li>Name the file something readable, e.g. <code>tessellating-ducks.svg</code>.</li>
    <li>Open a pull request. Once it's merged and the plotter pulls, your drawing shows up in the gallery with a computed time estimate.</li>
  </ol>
  <p class="muted">
    Tip: any vector editor works (Inkscape, Figma, Illustrator, or code). The
    drawing is scaled to fit the plotter's work area automatically.
  </p>
</section>

<section class="card">
  <h2>How it works</h2>
  <ul>
    <li><strong>Optimizer</strong> — merges path endpoints, chains touching paths, and reorders everything (greedy tour + 2-opt/Or-opt) to minimise pen-up travel.</li>
    <li><strong>Time estimates</strong> — an offline copy of the firmware's motion planner integrates the real trapezoidal speed profiles, calibrated against the machine.</li>
    <li><strong>Queue</strong> — submissions line up; an admin starts each plot when the pen and paper are ready.</li>
  </ul>
</section>

<style>
  section {
    margin-bottom: var(--space-4);
  }

  .hero h1 {
    margin-bottom: var(--space-2);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-3);
    flex-wrap: wrap;
  }

  code {
    font-family: var(--font-mono);
    background: var(--bg-inset);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 0.9em;
  }

  li {
    margin-bottom: var(--space-1);
  }
</style>
