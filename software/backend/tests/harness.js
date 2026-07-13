"use strict";
// Minimal assert-based harness (same shape as software/utils/tests/harness.js
// but with async test support, which the backend tests need).

const assert = require("assert");

function makeContext(failures, fileName) {
  let count = 0;
  const pending = [];
  return {
    check(label, fn) {
      count++;
      const run = async () => {
        try {
          await fn(assert);
          process.stdout.write(`    ok  ${label}\n`);
        } catch (error) {
          failures.push(`${fileName}: ${label}: ${error.message}`);
          process.stdout.write(`  FAIL  ${label}\n        ${error.message}\n`);
        }
      };
      pending.push(run);
    },
    async flush() {
      for (const run of pending) await run();
    },
    get count() {
      return count;
    },
  };
}

module.exports = { makeContext };
