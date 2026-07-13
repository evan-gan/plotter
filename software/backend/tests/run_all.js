#!/usr/bin/env node
"use strict";
// Entry point for the backend test suite (no hardware needed — everything
// runs against the simulator or plain objects). Build first: `pnpm test`.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { makeContext } = require("./harness");

// Speed up the firmware simulator massively so motion-dependent tests are
// quick. Must be set before dist/ modules load.
process.env.PLOTTER_SIM_TIME_SCALE = "50";
// Tests get their own throwaway data dir; never touch real queue data.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plotter-backend-test-"));

function findTestFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findTestFiles(full));
    else if (entry.isFile() && entry.name.startsWith("test_") && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

async function main() {
  const failures = [];
  let total = 0;
  for (const file of findTestFiles(__dirname).sort()) {
    const suite = require(file);
    const relative = path.relative(__dirname, file);
    process.stdout.write(`\n${relative} — ${suite.name}\n`);
    const context = makeContext(failures, relative);
    suite.run(context);
    await context.flush();
    total += context.count;
  }
  process.stdout.write(`\n${total} checks, ${failures.length} failure(s)\n`);
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
