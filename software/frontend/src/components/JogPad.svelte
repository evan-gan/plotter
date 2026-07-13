<script lang="ts">
  // Reusable jog pad: arrows + step-size selector. Emits moves through the
  // provided callback so it stays independent of any specific API client.
  export let onJog: (dxMm: number, dyMm: number) => Promise<void> | void;
  export let disabled = false;

  const STEPS = [0.1, 1, 10, 50];
  let stepMm = 10;
  let busy = false;

  async function jog(dxSign: number, dySign: number): Promise<void> {
    busy = true;
    try {
      await onJog(dxSign * stepMm, dySign * stepMm);
    } finally {
      busy = false;
    }
  }
</script>

<div class="jog">
  <div class="pad">
    <span></span>
    <button disabled={disabled || busy} on:click={() => jog(0, 1)} title="+Y">↑</button>
    <span></span>
    <button disabled={disabled || busy} on:click={() => jog(-1, 0)} title="−X">←</button>
    <span class="center mono">{stepMm}<small>mm</small></span>
    <button disabled={disabled || busy} on:click={() => jog(1, 0)} title="+X">→</button>
    <span></span>
    <button disabled={disabled || busy} on:click={() => jog(0, -1)} title="−Y">↓</button>
    <span></span>
  </div>
  <div class="steps">
    {#each STEPS as step}
      <button class:active={stepMm === step} on:click={() => (stepMm = step)}>{step}</button>
    {/each}
  </div>
</div>

<style>
  .jog { display: flex; gap: var(--space-3); align-items: center; }

  .pad {
    display: grid;
    grid-template-columns: repeat(3, 44px);
    grid-auto-rows: 44px;
    gap: var(--space-1);
  }

  .pad button { font-size: 1.1em; }

  .center {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    flex-direction: column;
    line-height: 1;
  }

  .center small { font-size: 0.6em; }

  .steps { display: flex; flex-direction: column; gap: var(--space-1); }
  .steps button { padding: 2px var(--space-2); font-size: 0.85em; }
  .steps button.active { border-color: var(--accent); color: var(--accent); }
</style>
