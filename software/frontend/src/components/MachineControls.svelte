<script lang="ts">
  // Machine panel: connection + position readout, jog, set-home, steppers,
  // pen up/down. Polls status while visible.
  import { onMount, onDestroy } from "svelte";
  import { api, type StatusSnapshot } from "../lib/api";
  import { serialConnected } from "../lib/stores";
  import JogPad from "./JogPad.svelte";

  export let onError: (message: string) => void;

  let status: StatusSnapshot | null = null;
  let timer: ReturnType<typeof setInterval>;

  async function refresh(): Promise<void> {
    try {
      status = await api.status();
    } catch {
      /* transient — next poll will catch up */
    }
  }

  onMount(() => {
    void refresh();
    timer = setInterval(refresh, 2500);
  });
  onDestroy(() => clearInterval(timer));

  async function call(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    }
  }

  const jog = (dx: number, dy: number) => call(() => api.jog(dx, dy));
</script>

<div class="card">
  <h3>Machine</h3>

  <div class="readout mono">
    {#if status?.machine.connected}
      <span class="ok">● {status.machine.state}</span>
      <span>X {status.machine.mx.toFixed(2)} · Y {status.machine.my.toFixed(2)}</span>
      <span class="muted">{status.machine.port}{status.simulated ? " (simulated)" : ""}</span>
    {:else}
      <span class="muted">● not connected</span>
      <button on:click={() => call(() => api.connect())}>Connect</button>
    {/if}
  </div>

  <div class="grid">
    <JogPad onJog={jog} disabled={!$serialConnected && !status?.machine.connected} />
    <div class="actions">
      <button on:click={() => call(() => api.setHome())} title="Make the current position X0 Y0">⌂ Set home here</button>
      <button on:click={() => call(() => api.steppers(false))}>Release steppers</button>
      <button on:click={() => call(() => api.steppers(true))}>Enable steppers</button>
      <div class="pen">
        <button on:click={() => call(() => api.pen(true))}>Pen down</button>
        <button on:click={() => call(() => api.pen(false))}>Pen up</button>
      </div>
    </div>
  </div>
  <p class="muted small">
    Hand-homing: release steppers → slide the head to the page corner → set home.
  </p>
</div>

<style>
  .readout {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
    font-size: 0.9em;
  }

  .ok { color: var(--ok); }

  .grid {
    display: flex;
    gap: var(--space-4);
    flex-wrap: wrap;
    align-items: flex-start;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .pen { display: flex; gap: var(--space-2); }
  .small { font-size: 0.8em; }
</style>
