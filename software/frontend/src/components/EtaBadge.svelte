<script lang="ts">
  import { formatDuration } from "../lib/format";

  export let seconds: number | null | undefined;
  export let label = "ETA";
</script>

<span class="badge" title="Estimated plot time">{label} {formatDuration(seconds)}</span>

<style>
  .badge {
    display: inline-block;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: var(--radius-small);
    padding: 2px var(--space-2);
    font-size: 0.85em;
    font-weight: 600;
    white-space: nowrap;
  }
</style>
