// Hash-based routing: works from any static host with zero server config.

import { readable } from "svelte/store";

export type RouteName = "home" | "submit" | "queue" | "gallery" | "admin";

const ROUTES: RouteName[] = ["home", "submit", "queue", "gallery", "admin"];

function currentRoute(): RouteName {
  const hash = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return (ROUTES as string[]).includes(hash) ? (hash as RouteName) : "home";
}

export const route = readable<RouteName>(currentRoute(), (set) => {
  const update = () => set(currentRoute());
  window.addEventListener("hashchange", update);
  return () => window.removeEventListener("hashchange", update);
});

export function navigate(target: RouteName): void {
  window.location.hash = `/${target}`;
}
