<script lang="ts">
  // Shared preview + time-estimate readout for anything that produces a
  // SubmissionPreview (the Submit page and the Photo page both use it).
  import type { SubmissionPreview } from "../lib/api";
  import { formatDuration, formatMm } from "../lib/format";
  import SvgPreview from "./SvgPreview.svelte";
  import EtaBadge from "./EtaBadge.svelte";

  export let preview: SubmissionPreview | null = null;
  export let title = "Preview";
  export let emptyMessage = "Pick a file to see the optimized preview and time estimate.";
</script>

<section class="card">
  <h2>{title}</h2>
  <SvgPreview svgMarkup={preview?.previewSvg ?? null} />

  {#if preview}
    <div class="estimate">
      <EtaBadge seconds={preview.eta.seconds} label="Estimated time" />
      {#if !preview.eta.liveSettings}
        <span class="muted small">(offline estimate — board not connected)</span>
      {/if}
    </div>
    <table class="mono small">
      <tbody>
        <tr><td>drawing</td><td>{formatMm(preview.eta.drawDistanceMm)}</td></tr>
        <tr><td>pen-up travel</td><td>{formatMm(preview.eta.travelDistanceMm)}</td></tr>
        <tr><td>pen lifts</td><td>{preview.eta.penLifts}</td></tr>
        <tr><td>moves</td><td>{preview.eta.moveCount}</td></tr>
        {#if preview.stats}
          <tr>
            <td>optimizer</td>
            <td>
              travel {preview.stats.penUpBeforeMm.toFixed(0)} → {preview.stats.penUpAfterMm.toFixed(0)} mm,
              lifts {preview.stats.penLiftsBefore} → {preview.stats.penLiftsAfter}
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
    <p class="muted small">
      Motion {formatDuration(preview.eta.motionSeconds)} + pen/dwell {formatDuration(preview.eta.fixedSeconds)}
      {#if preview.eta.calibrated}· calibrated{/if}
    </p>
  {:else}
    <p class="muted">{emptyMessage}</p>
  {/if}
</section>

<style>
  .estimate { margin: var(--space-3) 0 var(--space-2); display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 2px var(--space-2) 2px 0; vertical-align: top; }
  td:first-child { color: var(--text-dim); white-space: nowrap; }
  .small { font-size: 0.85em; }
</style>
