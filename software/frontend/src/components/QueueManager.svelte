<script lang="ts">
  // Admin queue: reorder queued jobs (up/down), start a specific one, delete.
  import { onMount } from "svelte";
  import { api, type Job } from "../lib/api";
  import { queueVersion } from "../lib/stores";
  import EtaBadge from "./EtaBadge.svelte";

  export let onError: (message: string) => void;

  let jobs: Job[] = [];

  async function refresh(): Promise<void> {
    try {
      jobs = (await api.queue()).jobs;
    } catch (error) {
      onError((error as Error).message);
    }
  }

  onMount(refresh);
  $: $queueVersion, void refresh();

  $: queued = jobs.filter((job) => job.status === "queued");

  async function move(index: number, delta: number): Promise<void> {
    const order = queued.map((job) => job.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    try {
      jobs = (await api.reorder(order)).jobs;
    } catch (error) {
      onError((error as Error).message);
    }
  }

  async function remove(job: Job): Promise<void> {
    if (!window.confirm(`Delete "${job.name}" from the queue?`)) return;
    try {
      jobs = (await api.deleteJob(job.id)).jobs;
    } catch (error) {
      onError((error as Error).message);
    }
  }

  async function startThis(job: Job): Promise<void> {
    try {
      await api.start(job.id);
    } catch (error) {
      onError((error as Error).message);
    }
  }
</script>

<div class="card">
  <h3>Queue order</h3>
  {#if queued.length === 0}
    <p class="muted">No queued jobs.</p>
  {/if}
  {#each queued as job, index (job.id)}
    <div class="entry">
      <div class="row">
        <span class="mono position">{index + 1}</span>
        <img class="thumb" src={`/api/jobs/${job.id}/preview.svg`} alt="" loading="lazy" />
        <div class="info">
          <strong>{job.name}</strong>
          <EtaBadge seconds={job.etaSeconds} />
          {#if job.layout}
            <span class="muted small">{job.layout.orientation} · {Math.round(job.layout.fillFraction * 100)}%</span>
            {#if job.layout.overflows}<span class="warn small" title="Extends past the printable margin">⚠ off-margin</span>{/if}
          {/if}
        </div>
        <div class="controls">
          <button title="Move up" disabled={index === 0} on:click={() => move(index, -1)}>↑</button>
          <button title="Move down" disabled={index === queued.length - 1} on:click={() => move(index, 1)}>↓</button>
          <button title="Plot this one next" on:click={() => startThis(job)}>▶</button>
          <button class="danger" title="Delete" on:click={() => remove(job)}>✕</button>
        </div>
      </div>
    </div>
  {/each}
</div>

<style>
  .entry {
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .entry:last-child { border-bottom: none; }

  .row {
    display: grid;
    grid-template-columns: 1.6em 52px 1fr auto;
    gap: var(--space-2);
    align-items: center;
  }

  .position { color: var(--text-dim); text-align: center; }
  .small { font-size: 0.8em; }
  .warn { color: var(--danger); }

  .thumb {
    width: 52px;
    height: 40px;
    object-fit: contain;
    background: #fff;
    border-radius: var(--radius-small);
  }

  .info {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    flex-wrap: wrap;
    min-width: 0;
  }

  .controls { display: flex; gap: var(--space-1); }
  .controls button { padding: var(--space-1) var(--space-2); }
</style>
