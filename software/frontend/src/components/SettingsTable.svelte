<script lang="ts">
  // Board settings ($$) with inline editing, plus reset-to-defaults.
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { tuneSettings } from "../lib/stores";

  export let onError: (message: string) => void;

  const DESCRIPTIONS: Record<string, string> = {
    $100: "steps/mm, motor A",
    $101: "steps/mm, motor B",
    $110: "max feed (drawing), mm/min",
    $111: "max rapid (travel), mm/min",
    $112: "per-motor speed cap, mm/min",
    $120: "acceleration, mm/s²",
    $122: "per-motor accel cap, mm/s²",
    $140: "junction deviation, mm",
    $141: "arc tolerance, mm",
  };

  let settings: Record<string, number> | null = null;
  let edits: Record<string, string> = {};
  let confirmReset = false;

  async function refresh(): Promise<void> {
    try {
      settings = (await api.settings()).settings;
      edits = {};
    } catch (error) {
      onError((error as Error).message);
    }
  }

  onMount(refresh);
  // The tuner broadcasts fresh settings as it writes them — mirror those.
  $: if ($tuneSettings) settings = $tuneSettings;

  async function save(key: string): Promise<void> {
    const value = Number(edits[key]);
    if (!Number.isFinite(value)) return onError(`${key}: "${edits[key]}" is not a number.`);
    try {
      settings = (await api.setSetting(key, value)).settings;
      edits = {};
    } catch (error) {
      onError((error as Error).message);
    }
  }

  async function resetDefaults(): Promise<void> {
    confirmReset = false;
    try {
      settings = (await api.resetDefaults()).settings;
    } catch (error) {
      onError((error as Error).message);
    }
  }
</script>

<div class="card">
  <h3>Board settings <span class="muted small">($$ — stored on the plotter)</span></h3>
  {#if !settings}
    <p class="muted">Not loaded — <button on:click={refresh}>read from board</button></p>
  {:else}
    <table class="mono">
      <tbody>
        {#each Object.keys(settings) as key (key)}
          <tr>
            <td class="key">{key}</td>
            <td>
              <input
                type="text"
                value={edits[key] ?? String(settings[key])}
                on:input={(e) => (edits[key] = (e.target as HTMLInputElement).value)}
                on:keydown={(e) => e.key === "Enter" && edits[key] !== undefined && save(key)}
              />
            </td>
            <td>
              {#if edits[key] !== undefined && edits[key] !== String(settings[key])}
                <button on:click={() => save(key)}>save</button>
              {/if}
            </td>
            <td class="muted description">{DESCRIPTIONS[key] ?? ""}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="footer">
      <button on:click={refresh}>↻ Re-read</button>
      {#if confirmReset}
        <button class="danger" on:click={resetDefaults}>Really reset ALL to firmware defaults?</button>
        <button on:click={() => (confirmReset = false)}>Cancel</button>
      {:else}
        <button class="danger" on:click={() => (confirmReset = true)}>Reset to defaults ($RST=*)</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  td { padding: var(--space-1) var(--space-2) var(--space-1) 0; }
  .key { color: var(--accent); white-space: nowrap; }
  input { width: 90px; padding: 2px var(--space-2); }
  .description { font-family: var(--font-body); font-size: 0.9em; }
  .footer { display: flex; gap: var(--space-2); margin-top: var(--space-3); flex-wrap: wrap; }
  .small { font-size: 0.7em; font-weight: 400; }
</style>
