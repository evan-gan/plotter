<script lang="ts">
  import { route } from "./lib/router";
  import Nav from "./components/Nav.svelte";
  import HomePage from "./pages/HomePage.svelte";
  import SubmitPage from "./pages/SubmitPage.svelte";
  import QueuePage from "./pages/QueuePage.svelte";
  import GalleryPage from "./pages/GalleryPage.svelte";
  import AdminPage from "./pages/AdminPage.svelte";
</script>

<Nav />

<main>
  {#if $route === "home"}
    <HomePage />
  {:else if $route === "submit"}
    <SubmitPage />
  {:else if $route === "queue"}
    <QueuePage />
  {:else if $route === "gallery"}
    <GalleryPage />
  {:else if $route === "admin"}
    <AdminPage />
  {/if}
</main>

<style>
  main {
    max-width: 1080px;
    margin: 0 auto;
    padding: var(--space-4);
  }
</style>
