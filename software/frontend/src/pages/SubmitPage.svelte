<script lang="ts">
  // Send a custom drawing: pick an SVG (or .gcode), see the optimized preview
  // + time estimate, then queue it.
  import { api, type SubmissionPreview } from "../lib/api";
  import { formatDuration, formatMm } from "../lib/format";
  import SvgPreview from "../components/SvgPreview.svelte";
  import EtaBadge from "../components/EtaBadge.svelte";
  import { navigate } from "../lib/router";

  let name = "";
  let fileName = "";
  let fileText = "";
  let fileKind: "svg" | "gcode" | null = null;
  let optimize = true;
  let preview: SubmissionPreview | null = null;
  let working = false;
  let submitted = false;
  let errorMessage = "";

  async function onFileChosen(eventTarget: EventTarget | null): Promise<void> {
    const input = eventTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    fileName = file.name;
    fileKind = /\.svg$/i.test(file.name) ? "svg" : "gcode";
    fileText = await file.text();
    if (!name) name = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    preview = null;
    submitted = false;
    errorMessage = "";
    await refreshEstimate();
  }

  function payload() {
    return fileKind === "svg"
      ? { name, svgText: fileText, optimize }
      : { name, gcodeText: fileText, optimize };
  }

  async function refreshEstimate(): Promise<void> {
    if (!fileText) return;
    working = true;
    errorMessage = "";
    try {
      preview = await api.estimate(payload());
    } catch (error) {
      preview = null;
      errorMessage = (error as Error).message;
    } finally {
      working = false;
    }
  }

  async function submit(): Promise<void> {
    working = true;
    errorMessage = "";
    try {
      await api.submit({ ...payload(), name: name || "untitled" });
      submitted = true;
    } catch (error) {
      errorMessage = (error as Error).message;
    } finally {
      working = false;
    }
  }
</script>

<h1>Send a drawing</h1>

<div class="layout">
  <section class="card">
    <label class="field">
      <span>Drawing file (SVG, or ready-made G-code)</span>
      <input type="file" accept=".svg,.gcode,.nc" on:change={(e) => onFileChosen(e.target)} />
    </label>

    <label class="field">
      <span>Name</span>
      <input type="text" bind:value={name} placeholder="my masterpiece" maxlength="80" />
    </label>

    <label class="toggle">
      <input type="checkbox" bind:checked={optimize} on:change={refreshEstimate} />
      <span>Optimize path order (fewer pen lifts, less travel){fileKind === "gcode" ? " — off = plot the file exactly as-is" : ""}</span>
    </label>

    <div class="actions">
      <button on:click={refreshEstimate} disabled={!fileText || working}>Re-estimate</button>
      <button class="primary" on:click={submit} disabled={!preview || working || submitted}>
        {submitted ? "Queued ✓" : "Add to queue"}
      </button>
    </div>

    {#if working}<p class="muted">Working…</p>{/if}
    {#if errorMessage}<p class="error">{errorMessage}</p>{/if}
    {#if submitted}
      <p class="ok">
        In the queue! <a href="#/queue" on:click|preventDefault={() => navigate("queue")}>Watch its spot →</a>
      </p>
    {/if}
  </section>

  <section class="card">
    <h2>Preview {fileName ? `— ${fileName}` : ""}</h2>
    <SvgPreview svgMarkup={preview?.previewSvg ?? null} />

    {#if preview}
      <div class="estimate">
        <EtaBadge seconds={preview.eta.seconds} label="Estimated time" />
        {#if !preview.eta.liveSettings}
          <span class="muted small">(offline estimate — board not connected)</span>
        {/if}
      </div>
      <table class="mono small">
        <tbody>
          <tr><td>drawing</td><td>{formatMm(preview.eta.drawDistanceMm)}</td></tr>
          <tr><td>pen-up travel</td><td>{formatMm(preview.eta.travelDistanceMm)}</td></tr>
          <tr><td>pen lifts</td><td>{preview.eta.penLifts}</td></tr>
          <tr><td>moves</td><td>{preview.eta.moveCount}</td></tr>
          {#if preview.stats}
            <tr>
              <td>optimizer</td>
              <td>
                travel {preview.stats.penUpBeforeMm.toFixed(0)} → {preview.stats.penUpAfterMm.toFixed(0)} mm,
                lifts {preview.stats.penLiftsBefore} → {preview.stats.penLiftsAfter}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
      <p class="muted small">
        Motion {formatDuration(preview.eta.motionSeconds)} + pen/dwell {formatDuration(preview.eta.fixedSeconds)}
        {#if preview.eta.calibrated}· calibrated{/if}
      </p>
    {:else}
      <p class="muted">Pick a file to see the optimized preview and time estimate.</p>
    {/if}
  </section>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
    align-items: start;
  }

  @media (max-width: 800px) {
    .layout { grid-template-columns: 1fr; }
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .field span { color: var(--text-dim); font-size: 0.9em; }

  .toggle {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    margin-bottom: var(--space-3);
  }

  .actions { display: flex; gap: var(--space-2); }
  .estimate { margin: var(--space-3) 0 var(--space-2); display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 2px var(--space-2) 2px 0; vertical-align: top; }
  td:first-child { color: var(--text-dim); white-space: nowrap; }
  .small { font-size: 0.85em; }
  .error { color: var(--danger); }
  .ok { color: var(--ok); }
</style>
