<script lang="ts">
  // Admin dashboard: a CNC-style plot-setup view up top (drawing on the paper),
  // the queue below it, and all the machine/tuning/settings surfaces tucked into
  // a right-hand slide-out drawer so the main view stays focused and scroll-free.
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { adminPassword } from "../lib/stores";
  import { get } from "svelte/store";
  import AdminLogin from "../components/AdminLogin.svelte";
  import PlotSetup from "../components/PlotSetup.svelte";
  import QueueManager from "../components/QueueManager.svelte";
  import AdvancedDrawer from "../components/AdvancedDrawer.svelte";

  let authed = false;
  let checking = true;
  let errorMessage = "";
  let drawerOpen = false;

  onMount(async () => {
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
    <div class="header-actions">
      <button on:click={() => (drawerOpen = true)}>⚙ Advanced</button>
      <button on:click={logout}>Lock</button>
    </div>
  </div>

  {#if errorMessage}
    <div class="error-banner">{errorMessage}</div>
  {/if}

  <div class="dashboard">
    <PlotSetup onError={showError} />
    <QueueManager onError={showError} />
  </div>

  <AdvancedDrawer open={drawerOpen} onClose={() => (drawerOpen = false)} onError={showError} />
{/if}

<style>
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
  }

  .header-actions { display: flex; gap: var(--space-2); }

  .error-banner {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid var(--danger);
    color: var(--danger);
    border-radius: var(--radius-small);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
  }

  .dashboard {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
</style>
