<script lang="ts">
  // Start / pause / resume / abort, plus live progress. Pure control surface:
  // all state comes from the SSE stores + queue refreshes.
  import { api } from "../lib/api";
  import { progress } from "../lib/stores";
  import { formatDuration } from "../lib/format";
  import ProgressBar from "./ProgressBar.svelte";

  export let queueLength = 0;
  export let onError: (message: string) => void;

  let confirmAbort = false;

  async function call(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      onError((error as Error).message);
    }
  }

  $: plotting = $progress !== null && $progress.state !== "idle";
  $: paused = $progress?.state === "paused";
  $: fraction = $progress && $progress.lineTotal > 0 ? $progress.linesSent / $progress.lineTotal : 0;
</script>

<div class="card">
  <h3>Plot control</h3>

  {#if $progress}
    <ProgressBar
      {fraction}
      label={`${$progress.linesSent}/${$progress.lineTotal} lines · ${formatDuration($progress.elapsedSeconds)} / ~${formatDuration($progress.etaSeconds)}`}
    />
  {/if}

  <div class="buttons">
    <button class="primary" disabled={plotting || queueLength === 0} on:click={() => call(() => api.start())}>
      ▶ Start next {queueLength > 0 ? `(${queueLength} queued)` : "(queue empty)"}
    </button>
    {#if paused}
      <button on:click={() => call(() => api.resume())}>⏵ Resume</button>
    {:else}
      <button disabled={!plotting} on:click={() => call(() => api.pause())}>⏸ Pause</button>
    {/if}
    {#if confirmAbort}
      <button class="danger" on:click={() => { confirmAbort = false; void call(() => api.abort()); }}>
        Really abort?
      </button>
      <button on:click={() => (confirmAbort = false)}>Cancel</button>
    {:else}
      <button class="danger" disabled={!plotting} on:click={() => (confirmAbort = true)}>⏹ Abort</button>
    {/if}
  </div>
  <p class="muted small">
    Pause is a realtime feed hold (pen stays down). Abort soft-resets the board
    and releases the steppers — re-home before the next plot.
  </p>
</div>

<style>
  .buttons {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: var(--space-3);
  }
  .small { font-size: 0.8em; }
</style>
