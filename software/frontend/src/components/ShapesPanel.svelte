<script lang="ts">
  // Diagnostic test shapes (same programs the standalone tuner draws).
  import { api } from "../lib/api";

  export let onError: (message: string) => void;

  const SHAPES = [
    { id: "circle", label: "20 mm circle", hint: "roundness sanity check (750 mm/min)" },
    { id: "slow-circle", label: "Slow circle", hint: "300 mm/min — flat spots at 45° reveal backlash" },
    { id: "max-circle", label: "Circle at max feed", hint: "draws at the board's $110" },
    { id: "backlash", label: "Backlash cross", hint: "doubled lines = lost motion on that belt" },
  ];

  async function draw(shape: string): Promise<void> {
    try {
      await api.drawShape(shape);
    } catch (error) {
      onError((error as Error).message);
    }
  }
</script>

<div class="card">
  <h3>Test shapes</h3>
  <p class="muted small">Pen + paper ready? Each shape starts at the current position and zeroes there.</p>
  <div class="shapes">
    {#each SHAPES as shape (shape.id)}
      <button on:click={() => draw(shape.id)} title={shape.hint}>{shape.label}</button>
    {/each}
  </div>
</div>

<style>
  .shapes { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .small { font-size: 0.8em; }
</style>
