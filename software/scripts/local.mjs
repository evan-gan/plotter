#!/usr/bin/env node
// `pnpm local` — one-command full-stack live-dev environment:
//   1. builds utils + backend once,
//   2. starts `tsc --watch` on utils + backend so TS edits recompile,
//   3. starts the backend under `node --watch` so it auto-restarts when
//      either package's compiled output changes (with the SIMULATED plotter
//      unless --real or PLOTTER_SERIAL says otherwise),
//   4. starts the Vite dev server for the frontend (proxying /api, with HMR).
//
// Result: edit any frontend OR backend/utils file and it reloads on the fly.
// Ctrl+C tears everything down. No hardware needed unless you ask for it.

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const softwareRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const utilsDir = path.join(softwareRoot, "utils");
const backendDir = path.join(softwareRoot, "backend");
const useRealPlotter = process.argv.includes("--real") || Boolean(process.env.PLOTTER_SERIAL);
const backendPort = process.env.PORT ?? "5180";

function run(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: softwareRoot,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  const prefix = `[${label}] `;
  const forward = (stream, out) =>
    stream.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) out.write(prefix + line + "\n");
      }
    });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  return child;
}

function runOnce(label, command, args, env) {
  return new Promise((resolve, reject) => {
    const child = run(label, command, args, { env });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with ${code}`))));
  });
}

const baseEnv = { ...process.env };

try {
  await runOnce("build", "pnpm", ["--filter", "plotter-utils", "--filter", "plotter-backend", "-r", "build"], baseEnv);
} catch (error) {
  console.error(String(error.message));
  process.exit(1);
}

// Incremental TS watchers. --preserveWatchOutput keeps the recompile log
// readable (tsc otherwise clears the screen on every rebuild, which would
// wipe the backend/frontend output we prefix and interleave here).
const tscArgs = ["--watch", "--preserveWatchOutput"];
const utilsWatch = run("tsc:utils", "pnpm", ["exec", "tsc", ...tscArgs], { cwd: utilsDir, env: baseEnv });
const backendWatch = run("tsc:backend", "pnpm", ["exec", "tsc", ...tscArgs], { cwd: backendDir, env: baseEnv });

const backendEnv = {
  ...baseEnv,
  PORT: backendPort,
  HOST: "127.0.0.1",
  ADMIN_PASSWORD: baseEnv.ADMIN_PASSWORD ?? "local",
  ...(useRealPlotter ? {} : { PLOTTER_SIMULATE: "1" }),
};
// `node --watch` follows the imported module graph (backend dist + the
// symlinked plotter-utils dist), so a recompile from either tsc watcher
// restarts the server automatically.
const backend = run("backend", "node", ["--watch", "dist/server.js"], { cwd: backendDir, env: backendEnv });

const frontendEnv = { ...baseEnv, BACKEND_PORT: backendPort };
const frontend = run("frontend", "pnpm", ["--filter", "plotter-frontend", "dev"], { env: frontendEnv });

console.log("");
console.log(`  backend:  http://127.0.0.1:${backendPort}  (${useRealPlotter ? "REAL plotter" : "simulated plotter"}, auto-restart on TS edits)`);
console.log(`  frontend: http://localhost:5173  (admin password: ${backendEnv.ADMIN_PASSWORD}, HMR)`);
console.log("");

const children = [utilsWatch, backendWatch, backend, frontend];
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGINT");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// If the server or frontend dies, tear the whole thing down. The tsc watchers
// are allowed to exit non-zero on a type error without killing the session —
// fix the error and the watcher recompiles + node --watch restarts.
for (const child of [backend, frontend]) {
  child.on("exit", () => shutdown());
}
