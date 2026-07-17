<script lang="ts">
  // Renders either inline SVG markup (from an estimate response) or a preview
  // URL (queue/gallery endpoints).
  //
  // Reliability note: a large drawing's preview SVG can contain tens of
  // thousands of <path> elements. Injecting that with {@html} builds that many
  // live DOM nodes and *freezes the tab* (a photo stipple is exactly this
  // case). Instead we hand the markup to the browser's image pipeline as a
  // blob-URL <img>: the SVG is parsed + rasterized once, off the live DOM tree,
  // so a huge preview stays smooth. The markup is backend-generated (never a
  // raw user upload), so wrapping it in a data/blob URL is safe.
  import { onDestroy } from "svelte";

  export let svgMarkup: string | null = null;
  export let src: string | null = null;
  export let alt = "drawing preview";

  let objectUrl: string | null = null;

  function releaseUrl(): void {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  // Rebuild the blob URL whenever the markup changes; revoke the previous one so
  // we don't leak object URLs across regenerations.
  $: {
    releaseUrl();
    if (svgMarkup) {
      objectUrl = URL.createObjectURL(new Blob([svgMarkup], { type: "image/svg+xml" }));
    }
  }

  onDestroy(releaseUrl);
</script>

<div class="preview">
  {#if objectUrl}
    <img src={objectUrl} {alt} />
  {:else if src}
    <img {src} {alt} loading="lazy" />
  {:else}
    <span class="muted">no preview</span>
  {/if}
</div>

<style>
  .preview {
    background: #fff;
    border-radius: var(--radius-small);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    min-height: 120px;
    padding: var(--space-2);
  }

  .preview img {
    max-width: 100%;
    max-height: 320px;
    height: auto;
    display: block;
  }
</style>
