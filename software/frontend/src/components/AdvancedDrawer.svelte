<script lang="ts">
  // Right-hand slide-out drawer for the "advanced" surfaces that don't belong in
  // the day-to-day plotting flow: machine jog/pen, diagnostic shapes, the tuner,
  // ETA calibration, raw settings, and the console. Keeps the main dashboard
  // uncluttered — open only when you need to fiddle with the machine.
  import MachineControls from "./MachineControls.svelte";
  import ShapesPanel from "./ShapesPanel.svelte";
  import TunerPanel from "./TunerPanel.svelte";
  import CalibrationPanel from "./CalibrationPanel.svelte";
  import SettingsTable from "./SettingsTable.svelte";
  import ConsoleLog from "./ConsoleLog.svelte";

  export let open = false;
  export let onClose: () => void;
  export let onError: (message: string) => void;

  const sections = [
    { id: "machine", label: "Machine" },
    { id: "shapes", label: "Test shapes" },
    { id: "tuner", label: "Tuning" },
    { id: "calibration", label: "ETA calibration" },
    { id: "settings", label: "Settings" },
    { id: "console", label: "Console" },
  ] as const;

  let active: (typeof sections)[number]["id"] = "machine";
</script>

{#if open}
  <div class="backdrop" on:click={onClose} role="presentation"></div>
{/if}

<aside class="drawer" class:open aria-hidden={!open}>
  <header class="head">
    <h3>Advanced</h3>
    <button class="close" title="Close" on:click={onClose}>✕</button>
  </header>

  <nav class="tabs">
    {#each sections as section}
      <button class:active={active === section.id} on:click={() => (active = section.id)}>{section.label}</button>
    {/each}
  </nav>

  <div class="body">
    {#if active === "machine"}
      <MachineControls {onError} />
    {:else if active === "shapes"}
      <ShapesPanel {onError} />
    {:else if active === "tuner"}
      <TunerPanel {onError} />
    {:else if active === "calibration"}
      <CalibrationPanel {onError} />
    {:else if active === "settings"}
      <SettingsTable {onError} />
    {:else if active === "console"}
      <ConsoleLog />
    {/if}
  </div>
</aside>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 40;
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    height: 100vh;
    width: min(460px, 92vw);
    background: var(--bg-raised);
    border-left: 1px solid var(--border);
    z-index: 41;
    transform: translateX(100%);
    transition: transform 0.2s ease;
    display: flex;
    flex-direction: column;
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.35);
  }

  .drawer.open { transform: translateX(0); }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .head h3 { margin: 0; }
  .close { padding: var(--space-1) var(--space-2); }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    padding: var(--space-1) var(--space-2);
    font-size: 0.85em;
  }

  .tabs button.active { border-color: var(--accent); color: var(--accent); }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
</style>
