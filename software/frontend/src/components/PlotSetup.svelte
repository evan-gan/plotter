<script lang="ts">
  // The dashboard centerpiece: the current/next drawing laid out on the paper,
  // with orientation + scale controls and the plot controls. Setup (drag/scale/
  // orientation/start) is only enabled while the machine is idle — you place the
  // next drawing once the current one finishes.
  import { onMount, onDestroy } from "svelte";
  import { api, type Job, type LayoutPatch, type StatusSnapshot } from "../lib/api";
  import { progress, queueVersion } from "../lib/stores";
  import { formatDuration } from "../lib/format";
  import PaperCanvas from "./PaperCanvas.svelte";
  import ProgressBar from "./ProgressBar.svelte";

  export let onError: (message: string) => void;

  let jobs: Job[] = [];
  let status: StatusSnapshot | null = null;
  let busy = false;
  let confirmAbort = false;
  let poll: ReturnType<typeof setInterval>;

  async function refreshJobs(): Promise<void> {
    try {
      jobs = (await api.queue()).jobs;
    } catch (error) {
      onError((error as Error).message);
    }
  }

  async function refreshStatus(): Promise<void> {
    try {
      status = await api.status();
    } catch {
      /* transient — keep the last snapshot */
    }
  }

  onMount(() => {
    void refreshJobs();
    void refreshStatus();
    poll = setInterval(refreshStatus, 1500); // live pen position + machine state
  });
  onDestroy(() => clearInterval(poll));

  // Refresh the queue whenever the server signals a change.
  $: $queueVersion, void refreshJobs();

  $: plotting = $progress !== null && $progress.state !== "idle";
  $: paused = $progress?.state === "paused";
  $: activeJob = jobs.find((job) => job.status === "plotting" || job.status === "paused") ?? null;
  $: nextJob = jobs.find((job) => job.status === "queued") ?? null;
  $: currentJob = activeJob ?? nextJob;
  // Setup is editable only when idle and the shown job is still queued.
  $: editable = !plotting && !!currentJob && currentJob.status === "queued";
  $: fraction = $progress && $progress.lineTotal > 0 ? $progress.linesSent / $progress.lineTotal : 0;

  async function applyPatch(patch: LayoutPatch): Promise<void> {
    if (!currentJob) return;
    try {
      const result = await api.setLayout(currentJob.id, patch);
      // Optimistic: splice the updated job in so the canvas reflects it at once.
      jobs = jobs.map((job) => (job.id === result.job.id ? result.job : job));
    } catch (error) {
      onError((error as Error).message);
    }
  }

  function setOrientation(orientation: "portrait" | "landscape" | null): void {
    // Reset position so the drawing re-anchors sensibly in the new orientation.
    void applyPatch({ orientation, positionXMm: null, positionYMm: null });
  }

  function setScalePercent(percent: number): void {
    const clamped = Math.max(1, Math.min(100, percent));
    void applyPatch({ fillFraction: clamped / 100 });
  }

  async function control(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    try {
      await action();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      busy = false;
    }
  }

  $: penConnected = !!status?.machine.connected;
  $: scalePercent = currentJob?.layout ? Math.round(currentJob.layout.fillFraction * 100) : 100;
</script>

<div class="card setup">
  <header class="head">
    <div class="titles">
      <h3>{currentJob ? currentJob.name : "Plot setup"}</h3>
      <span class="muted small">
        {#if !currentJob}Queue a drawing to set it up.
        {:else if activeJob}Plotting now — setup locks until it finishes.
        {:else}Ready to place · up next{/if}
      </span>
    </div>
    {#if currentJob?.layout}
      <div class="orient" role="group" aria-label="Paper orientation">
        <button class:active={editable && !currentJob.layoutRequest?.orientation} disabled={!editable} on:click={() => setOrientation(null)}>Auto</button>
        <button class:active={currentJob.layout.orientation === "portrait"} disabled={!editable} on:click={() => setOrientation("portrait")}>Portrait</button>
        <button class:active={currentJob.layout.orientation === "landscape"} disabled={!editable} on:click={() => setOrientation("landscape")}>Landscape</button>
      </div>
    {/if}
  </header>

  {#if currentJob}
    {#key currentJob.id}
      <PaperCanvas
        job={currentJob}
        penXMm={penConnected ? status?.machine.mx ?? null : null}
        penYMm={penConnected ? status?.machine.my ?? null : null}
        mirrorX={status?.paper?.mirrorX ?? false}
        {editable}
        onChange={applyPatch}
      />
    {/key}

    {#if currentJob.layout}
      <div class="scale-row">
        <label>
          Scale
          <input
            type="range" min="1" max="100" step="1"
            value={scalePercent}
            disabled={!editable}
            on:change={(event) => setScalePercent(Number((event.target as HTMLInputElement).value))}
          />
        </label>
        <input
          class="num" type="number" min="1" max="100"
          value={scalePercent}
          disabled={!editable}
          on:change={(event) => setScalePercent(Number((event.target as HTMLInputElement).value))}
        />
        <span class="muted">%</span>
        {#if !penConnected}<span class="muted small">· connect the board to see the pen</span>{/if}
      </div>
    {/if}
  {:else}
    <p class="muted">No drawing queued. Add one from the Gallery or Send-a-drawing page.</p>
  {/if}

  {#if $progress}
    <ProgressBar
      {fraction}
      label={`${$progress.linesSent}/${$progress.lineTotal} lines · ${formatDuration($progress.elapsedSeconds)} / ~${formatDuration($progress.etaSeconds)}`}
    />
  {/if}

  <div class="controls">
    <button
      class="primary"
      disabled={busy || plotting || !currentJob || currentJob.status !== "queued"}
      on:click={() => control(() => api.start(currentJob!.id))}
    >▶ Start this plot</button>
    {#if paused}
      <button disabled={busy} on:click={() => control(() => api.resume())}>⏵ Resume</button>
    {:else}
      <button disabled={busy || !plotting} on:click={() => control(() => api.pause())}>⏸ Pause</button>
    {/if}
    {#if confirmAbort}
      <button class="danger" on:click={() => { confirmAbort = false; void control(() => api.abort()); }}>Really abort?</button>
      <button on:click={() => (confirmAbort = false)}>Cancel</button>
    {:else}
      <button class="danger" disabled={busy || !plotting} on:click={() => (confirmAbort = true)}>⏹ Abort</button>
    {/if}
  </div>
</div>

<style>
  .setup { display: flex; flex-direction: column; gap: var(--space-3); }

  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); }
  .titles h3 { margin: 0; }
  .titles { display: flex; flex-direction: column; gap: 2px; }

  .orient { display: flex; gap: 0; }
  .orient button { border-radius: 0; padding: var(--space-1) var(--space-2); }
  .orient button:first-child { border-radius: var(--radius-small) 0 0 var(--radius-small); }
  .orient button:last-child { border-radius: 0 var(--radius-small) var(--radius-small) 0; }
  .orient button + button { border-left: none; }
  .orient button.active { border-color: var(--accent); color: var(--accent); }

  .scale-row { display: flex; align-items: center; gap: var(--space-2); }
  .scale-row label { display: flex; align-items: center; gap: var(--space-2); flex: 1; }
  .scale-row input[type="range"] { flex: 1; }
  .num { width: 5em; }

  .controls { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .small { font-size: 0.8em; }
</style>
