<script lang="ts">
  // Speed/accel tuner: drives the firmware-tools tuning engine through the
  // backend. The engine walks four tests (C/D/A/B) and asks after each pass
  // whether the print skipped — answer with the Pass/Fail buttons here.
  import { api } from "../lib/api";
  import { tuneRunning, tunePrompt, tuneSummary } from "../lib/stores";

  export let onError: (message: string) => void;

  let mode: "coarse" | "fine" = "coarse";
  let tests = "CDAB";

  async function call(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      onError((error as Error).message);
    }
  }

  const verdictButtons = [
    { v: "y", label: "✓ Pass (no skipping)", cls: "primary" },
    { v: "n", label: "✗ Fail (skipped / off)", cls: "danger" },
    { v: "r", label: "↻ Retry same value", cls: "" },
    { v: "q", label: "Quit session", cls: "" },
  ];
</script>

<div class="card">
  <h3>Speed & accel tuning</h3>
  <p class="muted small">
    Runs the bisection tuner (see firmware/TUNING.md): the machine draws test
    patterns at increasing values; you judge each pass. Results are written to
    the board's flash.
  </p>

  {#if !$tuneRunning}
    <div class="controls">
      <label>
        Mode
        <select bind:value={mode}>
          <option value="coarse">coarse (fast, big steps)</option>
          <option value="fine">fine (slow, precise)</option>
        </select>
      </label>
      <label>
        Tests
        <select bind:value={tests}>
          <option value="CDAB">all (C→D→A→B)</option>
          <option value="C">C — accel only</option>
          <option value="D">D — motor accel only</option>
          <option value="A">A — max feed only</option>
          <option value="B">B — motor speed only</option>
        </select>
      </label>
      <button class="primary" on:click={() => call(() => api.tuneStart(mode, tests))}>Start tuning</button>
    </div>
  {:else}
    <div class="running">
      <span class="spinner"></span> Session running…
      <button class="danger" on:click={() => call(() => api.tuneStop())}>Stop</button>
    </div>
  {/if}

  {#if $tunePrompt}
    <div class="prompt">
      <p>
        {#if $tunePrompt.question}{$tunePrompt.question}{:else}Did that pass look clean?{/if}
        {#if $tunePrompt.value}<span class="mono value">{$tunePrompt.value}</span>{/if}
      </p>
      <div class="verdicts">
        {#each verdictButtons as button (button.v)}
          <button class={button.cls} on:click={() => call(() => api.tuneVerdict(button.v))}>{button.label}</button>
        {/each}
      </div>
    </div>
  {/if}

  {#if $tuneSummary}
    <table class="mono small">
      <thead><tr><th>test</th><th>setting</th><th>result</th></tr></thead>
      <tbody>
        {#each $tuneSummary as row}
          <tr>
            <td>{(row as Record<string, unknown>).test ?? (row as Record<string, unknown>).name ?? ""}</td>
            <td>{(row as Record<string, unknown>).setting ?? ""}</td>
            <td>{(row as Record<string, unknown>).value ?? JSON.stringify(row)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .controls { display: flex; gap: var(--space-3); align-items: flex-end; flex-wrap: wrap; }
  label { display: flex; flex-direction: column; gap: var(--space-1); font-size: 0.85em; color: var(--text-dim); }

  .running { display: flex; align-items: center; gap: var(--space-3); }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .prompt {
    margin-top: var(--space-3);
    border: 1px solid var(--warn);
    border-radius: var(--radius-small);
    padding: var(--space-3);
    background: color-mix(in srgb, var(--warn) 8%, transparent);
  }

  .value { color: var(--warn); margin-left: var(--space-2); }
  .verdicts { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  table { margin-top: var(--space-3); border-collapse: collapse; }
  th, td { text-align: left; padding: 2px var(--space-3) 2px 0; }
  th { color: var(--text-dim); font-weight: 500; }
  .small { font-size: 0.85em; }
</style>
