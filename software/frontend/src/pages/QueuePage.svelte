<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Job } from "../lib/api";
  import { progress, queueVersion } from "../lib/stores";
  import { formatDuration } from "../lib/format";
  import JobCard from "../components/JobCard.svelte";
  import ProgressBar from "../components/ProgressBar.svelte";

  let jobs: Job[] = [];
  let loadError = "";

  async function refresh(): Promise<void> {
    try {
      jobs = (await api.queue()).jobs;
      loadError = "";
    } catch (error) {
      loadError = (error as Error).message;
    }
  }

  onMount(refresh);
  $: $queueVersion, void refresh(); // server-side changes push a bump over SSE

  $: activeJob = jobs.find((job) => job.status === "plotting" || job.status === "paused") ?? null;
  $: queued = jobs.filter((job) => job.status === "queued");
  $: finished = jobs.filter((job) => ["done", "aborted", "failed"].includes(job.status)).reverse();
  $: fraction = $progress && $progress.lineTotal > 0 ? $progress.linesSent / $progress.lineTotal : 0;
</script>

<h1>Queue</h1>
{#if loadError}<p class="error">{loadError}</p>{/if}

{#if activeJob}
  <section class="card now-plotting">
    <h2>Now plotting</h2>
    <JobCard job={activeJob}>
      {#if $progress}
        <ProgressBar
          {fraction}
          label={`${$progress.linesSent}/${$progress.lineTotal} lines · ${formatDuration($progress.elapsedSeconds)} elapsed`}
        />
      {/if}
    </JobCard>
  </section>
{/if}

<section>
  <h2>Up next <span class="muted">({queued.length})</span></h2>
  {#if queued.length === 0}
    <p class="muted">Queue is empty — <a href="#/submit">send something</a>.</p>
  {/if}
  {#each queued as job, index (job.id)}
    <div class="row">
      <span class="position mono">{index + 1}</span>
      <JobCard {job} />
    </div>
  {/each}
</section>

{#if finished.length > 0}
  <section>
    <h2>Recently plotted</h2>
    {#each finished.slice(0, 10) as job (job.id)}
      <JobCard {job} />
    {/each}
  </section>
{/if}

<style>
  section { margin-bottom: var(--space-4); }
  .now-plotting { border-color: var(--warn); }
  .row {
    display: grid;
    grid-template-columns: 2em 1fr;
    gap: var(--space-2);
    align-items: center;
  }
  .position { color: var(--text-dim); text-align: center; }
  section :global(article) { margin-bottom: var(--space-2); }
  .error { color: var(--danger); }
</style>
