<script lang="ts">
  import { route } from "../lib/router";
  import { serialConnected, progress } from "../lib/stores";

  const links = [
    { target: "home", label: "Home" },
    { target: "submit", label: "Send a drawing" },
    { target: "photo", label: "Photo → sketch" },
    { target: "queue", label: "Queue" },
    { target: "gallery", label: "Gallery" },
    { target: "admin", label: "Admin" },
  ] as const;
</script>

<header>
  <span class="brand">Plotter</span>
  <nav>
    {#each links as link}
      <a href={`#/${link.target}`} class:active={$route === link.target}>{link.label}</a>
    {/each}
  </nav>
  <span class="status">
    {#if $progress}
      <span class="dot plotting"></span> plotting
    {:else if $serialConnected}
      <span class="dot ok"></span> online
    {:else}
      <span class="dot"></span> offline
    {/if}
  </span>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--bg-raised);
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .brand {
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  nav {
    display: flex;
    gap: var(--space-2);
    flex: 1;
    flex-wrap: wrap;
  }

  nav a {
    color: var(--text-dim);
    text-decoration: none;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-small);
  }

  nav a.active {
    color: var(--text);
    background: var(--accent-soft);
  }

  .status {
    color: var(--text-dim);
    font-size: 0.85em;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    white-space: nowrap;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-dim);
    display: inline-block;
  }

  .dot.ok {
    background: var(--ok);
  }

  .dot.plotting {
    background: var(--warn);
    animation: pulse 1.2s infinite;
  }

  @keyframes pulse {
    50% { opacity: 0.3; }
  }
</style>
