<script lang="ts">
  // Admin panel: password-gated control surface assembled from independent
  // components (plot control, queue, machine, tuning, calibration, settings).
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { adminPassword, queueVersion } from "../lib/stores";
  import { get } from "svelte/store";
  import AdminLogin from "../components/AdminLogin.svelte";
  import PlotControls from "../components/PlotControls.svelte";
  import QueueManager from "../components/QueueManager.svelte";
  import MachineControls from "../components/MachineControls.svelte";
  import ShapesPanel from "../components/ShapesPanel.svelte";
  import TunerPanel from "../components/TunerPanel.svelte";
  import CalibrationPanel from "../components/CalibrationPanel.svelte";
  import SettingsTable from "../components/SettingsTable.svelte";
  import ConsoleLog from "../components/ConsoleLog.svelte";

  let authed = false;
  let checking = true;
  let errorMessage = "";
  let queueLength = 0;

  onMount(async () => {
    // Re-validate a password kept from earlier in this browser session.
    if (get(adminPassword)) {
      try {
        await api.adminLogin();
        authed = true;
      } catch {
        adminPassword.set("");
      }
    }
    checking = false;
  });

  async function refreshQueueLength(): Promise<void> {
    try {
      queueLength = (await api.queue()).jobs.filter((job) => job.status === "queued").length;
    } catch {
      /* ignore */
    }
  }

  $: if (authed) {
    $queueVersion;
    void refreshQueueLength();
  }

  function showError(message: string): void {
    errorMessage = message;
    setTimeout(() => {
      if (errorMessage === message) errorMessage = "";
    }, 8000);
  }

  function logout(): void {
    adminPassword.set("");
    authed = false;
  }
</script>

{#if checking}
  <p class="muted">…</p>
{:else if !authed}
  <AdminLogin onAuthed={() => (authed = true)} />
{:else}
  <div class="header">
    <h1>Admin</h1>
    <button on:click={logout}>Lock</button>
  </div>

  {#if errorMessage}
    <div class="error-banner">{errorMessage}</div>
  {/if}

  <div class="columns">
    <div class="column">
      <PlotControls {queueLength} onError={showError} />
      <QueueManager onError={showError} />
      <MachineControls onError={showError} />
    </div>
    <div class="column">
      <ShapesPanel onError={showError} />
      <TunerPanel onError={showError} />
      <CalibrationPanel onError={showError} />
      <SettingsTable onError={showError} />
    </div>
  </div>

  <section class="console-section">
    <h3>Console</h3>
    <ConsoleLog />
  </section>
{/if}

<style>
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
  }

  .error-banner {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid var(--danger);
    color: var(--danger);
    border-radius: var(--radius-small);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
  }

  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
    align-items: start;
  }

  @media (max-width: 900px) {
    .columns { grid-template-columns: 1fr; }
  }

  .column { display: flex; flex-direction: column; gap: var(--space-4); }
  .console-section { margin-top: var(--space-4); }
</style>
