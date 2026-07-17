<script lang="ts">
  // Take a photo (or upload one), turn it into single-pen line art in the
  // browser, then estimate + queue it exactly like the Send-a-drawing page —
  // the generated SVG goes through the same /api/estimate + /api/submit flow.
  import { tick } from "svelte";
  import { api, type SubmissionPreview } from "../lib/api";
  import { navigate } from "../lib/router";
  import EstimateResult from "../components/EstimateResult.svelte";
  import CameraCapture from "../components/CameraCapture.svelte";
  import {
    imageToSketchSvg,
    DEFAULT_SKETCH,
    DETAIL_PRESETS,
    type SketchSettings,
  } from "../lib/imageLineart";

  let capturedImage: HTMLImageElement | null = null;
  let settings: SketchSettings = { ...DEFAULT_SKETCH };
  let sketchSvg = "";

  let name = "my photo sketch";
  let optimize = true;
  let preview: SubmissionPreview | null = null;
  let generating = false;
  let estimating = false;
  let submitted = false;
  let errorMessage = "";

  function onCapture(image: HTMLImageElement): void {
    capturedImage = image;
    submitted = false;
    generateSketch();
  }

  async function generateSketch(): Promise<void> {
    if (!capturedImage) return;
    generating = true;
    errorMessage = "";
    preview = null;
    // Yield once so the "Generating…" state paints before the (heavy) synchronous
    // stroke generation blocks the main thread.
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      sketchSvg = imageToSketchSvg(capturedImage, settings);
      await refreshEstimate();
    } catch (error) {
      errorMessage = (error as Error).message;
    } finally {
      generating = false;
    }
  }

  async function refreshEstimate(): Promise<void> {
    if (!sketchSvg) return;
    estimating = true;
    errorMessage = "";
    try {
      preview = await api.estimate({ name, svgText: sketchSvg, optimize });
    } catch (error) {
      preview = null;
      errorMessage = (error as Error).message;
    } finally {
      estimating = false;
    }
  }

  function setDensity(density: number): void {
    settings.density = density;
    generateSketch();
  }

  function shuffle(): void {
    settings.seed = Math.floor(Math.random() * 1e9);
    generateSketch();
  }

  async function submit(): Promise<void> {
    estimating = true;
    errorMessage = "";
    try {
      await api.submit({ name: name || "photo sketch", svgText: sketchSvg, optimize });
      submitted = true;
    } catch (error) {
      errorMessage = (error as Error).message;
    } finally {
      estimating = false;
    }
  }
</script>

<h1>Photo → sketch</h1>
<p class="muted">Snap a photo and the plotter draws it as single-pen line art.</p>

<div class="layout">
  <section class="card">
    <CameraCapture {onCapture} />

    {#if capturedImage}
      <div class="settings">
        <div class="field">
          <span>Detail — fewer dots plot faster</span>
          <div class="segmented" role="group" aria-label="Detail level">
            {#each DETAIL_PRESETS as preset}
              <button
                type="button"
                class:active={settings.density === preset.density}
                on:click={() => setDensity(preset.density)}
                disabled={generating}
              >{preset.label}</button>
            {/each}
          </div>
        </div>

        <div class="row">
          <label class="field">
            <span>Contrast ({settings.contrast.toFixed(1)})</span>
            <input type="range" min="0.5" max="3" step="0.1" bind:value={settings.contrast} on:change={generateSketch} />
          </label>
          <label class="field">
            <span>Darkness ({settings.gamma.toFixed(1)})</span>
            <input type="range" min="0.6" max="2.5" step="0.1" bind:value={settings.gamma} on:change={generateSketch} />
          </label>
        </div>

        <label class="field">
          <span>Name</span>
          <input type="text" bind:value={name} placeholder="my photo sketch" maxlength="80" />
        </label>

        <label class="toggle">
          <input type="checkbox" bind:checked={optimize} on:change={refreshEstimate} />
          <span>Optimize path order (fewer pen lifts, less travel)</span>
        </label>

        <div class="actions">
          <button on:click={generateSketch} disabled={generating}>Regenerate</button>
          <button on:click={shuffle} disabled={generating}>🎲 Shuffle</button>
          <button class="primary" on:click={submit} disabled={!preview || generating || estimating || submitted}>
            {submitted ? "Queued ✓" : "Add to queue"}
          </button>
        </div>

        {#if generating}<p class="muted">Generating sketch…</p>{/if}
        {#if estimating && !generating}<p class="muted">Estimating…</p>{/if}
        {#if errorMessage}<p class="error">{errorMessage}</p>{/if}
        {#if submitted}
          <p class="ok">
            In the queue! <a href="#/queue" on:click|preventDefault={() => navigate("queue")}>Watch its spot →</a>
          </p>
        {/if}
      </div>
    {/if}
  </section>

  <EstimateResult
    {preview}
    title="Sketch preview"
    emptyMessage="Take or upload a photo to see the sketch and time estimate."
  />
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

  .settings { margin-top: var(--space-4); }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
    flex: 1;
  }

  .field span { color: var(--text-dim); font-size: 0.9em; }

  .row { display: flex; gap: var(--space-3); }

  .segmented { display: flex; }
  .segmented button { border-radius: 0; flex: 1; }
  .segmented button:first-child { border-radius: var(--radius-small) 0 0 var(--radius-small); }
  .segmented button:last-child { border-radius: 0 var(--radius-small) var(--radius-small) 0; }
  .segmented button + button { border-left: none; }
  .segmented button.active { border-color: var(--accent); color: var(--accent); }

  .toggle {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    margin-bottom: var(--space-3);
  }

  .actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .error { color: var(--danger); }
  .ok { color: var(--ok); }
</style>
