<script lang="ts">
  // Renders either inline SVG markup (from an estimate response) or a preview
  // URL (queue/gallery endpoints). Backend-generated SVG only — never raw
  // user uploads — so {@html} is safe here.
  export let svgMarkup: string | null = null;
  export let src: string | null = null;
  export let alt = "drawing preview";
</script>

<div class="preview">
  {#if svgMarkup}
    {@html svgMarkup}
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

  .preview :global(svg),
  .preview img {
    max-width: 100%;
    max-height: 320px;
    height: auto;
    display: block;
  }
</style>
