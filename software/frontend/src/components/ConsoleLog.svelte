<script lang="ts">
  // Live server/firmware log (from SSE). Sticks to the bottom unless the
  // user has scrolled up to read history.
  import { logLines } from "../lib/stores";
  import { afterUpdate } from "svelte";

  let container: HTMLDivElement | null = null;
  let pinnedToBottom = true;
  let lastRenderedCount = 0;

  function onScroll(): void {
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
    // Only assign on an actual change: assigning the same value would still
    // invalidate and, combined with the auto-scroll below, spin a feedback loop.
    if (atBottom !== pinnedToBottom) pinnedToBottom = atBottom;
  }

  // Auto-scroll ONLY when new lines arrived (not on every render), so the
  // scrollTop write can't ping-pong with onScroll into an infinite loop.
  afterUpdate(() => {
    if (container && pinnedToBottom && $logLines.length !== lastRenderedCount) {
      lastRenderedCount = $logLines.length;
      container.scrollTop = container.scrollHeight;
    }
  });
</script>

<div class="console mono" bind:this={container} on:scroll={onScroll}>
  {#each $logLines as line}
    <div class:error={line.text.includes("!")}>{line.text}</div>
  {/each}
  {#if $logLines.length === 0}
    <div class="muted">— no output yet —</div>
  {/if}
</div>

<style>
  .console {
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    padding: var(--space-3);
    height: 220px;
    overflow-y: auto;
    font-size: 0.8em;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .console div.error {
    color: var(--danger);
  }
</style>
