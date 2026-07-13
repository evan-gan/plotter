<script lang="ts">
  // ETA calibration: runs timed test moves on the machine, fits the three
  // correction knobs, and saves them to the HOST's eta-calibration.json
  // (never the board — board settings live in the settings table).
  import { api } from "../lib/api";
  import { calRows, calSummary, calRunning, calSaved } from "../lib/stores";

  export let onError: (message: string) => void;

  async function call(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      onError((error as Error).message);
    }
  }

  const asRecord = (value: unknown) => value as Record<string, unknown>;
</script>

<div class="card">
  <h3>ETA calibration</h3>
  <p class="muted small">
    Times 5 motion patterns on the machine (pen up — clear ~80 mm of +X/+Y)
    and fits the estimator's correction knobs. Saved on the server, not the board.
  </p>

  <div class="controls">
    <button class="primary" disabled={$calRunning} on:click={() => call(() => api.calibrate())}>
      {$calRunning ? "Running…" : "Run ETA calibration"}
    </button>
    <button disabled={!$calSummary} on:click={() => call(() => api.saveCalibration())}>
      💾 Save scalers
    </button>
    {#if $calSaved}
      <span class="ok small">saved ✓</span>
    {/if}
  </div>

  {#if $calRows.length > 0}
    <table class="mono small">
      <thead><tr><th>test</th><th>estimate</th><th>actual</th><th>ratio</th></tr></thead>
      <tbody>
        {#each $calRows as row}
          <tr>
            <td>{asRecord(row).label ?? asRecord(row).name ?? ""}</td>
            <td>{Number(asRecord(row).estimateS ?? asRecord(row).estimate ?? 0).toFixed(2)}s</td>
            <td>{Number(asRecord(row).actualS ?? asRecord(row).actual ?? 0).toFixed(2)}s</td>
            <td>{Number(asRecord(row).ratio ?? 0).toFixed(3)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if $calSummary}
    <div class="knobs mono small">
      {#each Object.entries($calSummary.calibration) as [key, value]}
        <span><span class="muted">{key}</span> {typeof value === "number" ? value.toFixed(4) : value}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .controls { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
  table { margin-top: var(--space-3); border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 2px var(--space-3) 2px 0; }
  th { color: var(--text-dim); font-weight: 500; }
  .knobs { display: flex; gap: var(--space-3); margin-top: var(--space-3); flex-wrap: wrap; }
  .small { font-size: 0.85em; }
  .ok { color: var(--ok); }
</style>
