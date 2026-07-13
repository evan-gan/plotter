<script lang="ts">
  import { onMount } from "svelte";
  import { api, type GalleryEntry } from "../lib/api";
  import EtaBadge from "../components/EtaBadge.svelte";
  import SvgPreview from "../components/SvgPreview.svelte";

  let entries: GalleryEntry[] = [];
  let loading = true;
  let loadError = "";
  let queuedIds = new Set<string>();
  let failedMessage = "";

  onMount(async () => {
    try {
      entries = (await api.gallery()).entries;
    } catch (error) {
      loadError = (error as Error).message;
    } finally {
      loading = false;
    }
  });

  async function pick(entry: GalleryEntry): Promise<void> {
    failedMessage = "";
    try {
      await api.enqueueGalleryEntry(entry.id);
      queuedIds = new Set(queuedIds).add(entry.id);
    } catch (error) {
      failedMessage = `Couldn't queue "${entry.name}": ${(error as Error).message}`;
    }
  }
</script>

<h1>Gallery</h1>
<p class="muted">
  Community drawings from the repo's <code>drawings/</code> folder — add yours
  via a <a href="#/home">GitHub pull request</a>. Times are computed for the
  machine's current tuning.
</p>

{#if loading}<p class="muted">Loading…</p>{/if}
{#if loadError}<p class="error">{loadError}</p>{/if}
{#if failedMessage}<p class="error">{failedMessage}</p>{/if}

<div class="grid">
  {#each entries as entry (entry.id)}
    <article class="card">
      <SvgPreview src={`/api/gallery/${entry.id}/preview.svg`} alt={entry.name} />
      <header>
        <strong>{entry.name}</strong>
        <EtaBadge seconds={entry.etaSeconds} />
      </header>
      {#if entry.penUpSavedMm !== null && entry.penUpSavedMm > 1}
        <p class="muted small">optimizer saved {entry.penUpSavedMm.toFixed(0)} mm of travel</p>
      {/if}
      {#if entry.error}
        <p class="error small">{entry.error}</p>
      {:else}
        <button class="primary" on:click={() => pick(entry)} disabled={queuedIds.has(entry.id)}>
          {queuedIds.has(entry.id) ? "Queued ✓" : "Plot this"}
        </button>
      {/if}
    </article>
  {/each}
</div>

{#if !loading && entries.length === 0}
  <p class="muted">Nothing here yet — be the first to PR a drawing!</p>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: var(--space-3);
  }

  article {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-2);
  }

  .small { font-size: 0.8em; margin: 0; }
  .error { color: var(--danger); }

  code {
    font-family: var(--font-mono);
    background: var(--bg-inset);
    padding: 1px 5px;
    border-radius: 4px;
  }
</style>
