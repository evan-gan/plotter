#!/usr/bin/env node
"use strict";
// Entry point: runs every test file under tests/ (recursively). Requires the
// library to be built first (`pnpm build` or `pnpm test`, which builds).

const fs = require("fs");
const path = require("path");
const { makeContext } = require("./harness");

function findTestFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findTestFiles(full));
    else if (entry.isFile() && entry.name.startsWith("test_") && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function main() {
  const failures = [];
  let total = 0;
  for (const file of findTestFiles(__dirname).sort()) {
    const suite = require(file);
    const relative = path.relative(__dirname, file);
    process.stdout.write(`\n${relative} — ${suite.name}\n`);
    const context = makeContext(failures, relative);
    suite.run(context);
    total += context.count;
  }
  process.stdout.write(`\n${total} checks, ${failures.length} failure(s)\n`);
  if (failures.length > 0) process.exit(1);
}

main();
