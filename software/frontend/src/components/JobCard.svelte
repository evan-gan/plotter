<script lang="ts">
  import type { Job } from "../lib/api";
  import { formatTimestamp } from "../lib/format";
  import EtaBadge from "./EtaBadge.svelte";
  import SvgPreview from "./SvgPreview.svelte";

  export let job: Job;
  export let showPreview = true;

  const STATUS_LABEL: Record<Job["status"], string> = {
    queued: "queued",
    plotting: "plotting…",
    paused: "paused",
    done: "done",
    aborted: "aborted",
    failed: "failed",
  };
</script>

<article class="card job">
  {#if showPreview}
    <SvgPreview src={`/api/jobs/${job.id}/preview.svg`} alt={job.name} />
  {/if}
  <div class="meta">
    <header>
      <strong>{job.name}</strong>
      <span class={`status ${job.status}`}>{STATUS_LABEL[job.status]}</span>
    </header>
    <div class="row">
      <EtaBadge seconds={job.etaSeconds} />
      <span class="muted">{job.lineCount} lines · {formatTimestamp(job.createdAt)}</span>
    </div>
    {#if job.stats}
      <div class="muted small">
        pen-up travel {job.stats.penUpBeforeMm.toFixed(0)} → {job.stats.penUpAfterMm.toFixed(0)} mm,
        lifts {job.stats.penLiftsBefore} → {job.stats.penLiftsAfter}
      </div>
    {/if}
    {#if job.error}
      <div class="error small">{job.error}</div>
    {/if}
    <slot />
  </div>
</article>

<style>
  .job {
    display: grid;
    grid-template-columns: 160px 1fr;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .job :global(.preview) {
    min-height: 90px;
  }

  header {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    align-items: baseline;
  }

  .row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
    margin-top: var(--space-1);
  }

  .status {
    font-size: 0.8em;
    padding: 1px var(--space-2);
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-dim);
  }

  .status.plotting { color: var(--warn); border-color: var(--warn); }
  .status.paused { color: var(--warn); border-color: var(--warn); }
  .status.done { color: var(--ok); border-color: var(--ok); }
  .status.failed, .status.aborted { color: var(--danger); border-color: var(--danger); }

  .small { font-size: 0.8em; }
  .error { color: var(--danger); }

  @media (max-width: 600px) {
    .job { grid-template-columns: 1fr; }
  }
</style>
