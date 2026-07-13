<script lang="ts">
  import { api } from "../lib/api";
  import { adminPassword } from "../lib/stores";

  export let onAuthed: () => void;

  let candidate = "";
  let errorMessage = "";
  let checking = false;

  async function login(): Promise<void> {
    checking = true;
    errorMessage = "";
    adminPassword.set(candidate);
    try {
      await api.adminLogin();
      onAuthed();
    } catch (error) {
      adminPassword.set("");
      errorMessage = (error as Error).message;
    } finally {
      checking = false;
    }
  }
</script>

<div class="card login">
  <h2>Admin</h2>
  <p class="muted">Enter the admin password to control the plotter.</p>
  <form on:submit|preventDefault={login}>
    <input type="password" bind:value={candidate} placeholder="password" autocomplete="current-password" />
    <button class="primary" type="submit" disabled={!candidate || checking}>Unlock</button>
  </form>
  {#if errorMessage}<p class="error">{errorMessage}</p>{/if}
</div>

<style>
  .login { max-width: 420px; margin: 10vh auto; }
  form { display: flex; gap: var(--space-2); }
  input { flex: 1; }
  .error { color: var(--danger); }
</style>
