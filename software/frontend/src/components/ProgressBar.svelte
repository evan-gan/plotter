<script lang="ts">
  export let fraction = 0; // 0..1
  export let label = "";
</script>

<div class="track" role="progressbar" aria-valuenow={Math.round(fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
  <div class="fill" style={`width:${Math.min(100, Math.max(0, fraction * 100))}%`}></div>
  {#if label}<span class="label">{label}</span>{/if}
</div>

<style>
  .track {
    position: relative;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 999px;
    height: 22px;
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s ease;
  }

  .label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.78em;
    color: var(--text);
    text-shadow: 0 1px 2px rgb(0 0 0 / 60%);
  }
</style>
