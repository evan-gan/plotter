"use strict";
// Minimal assert-based test harness shared by every plotter-utils test file.
// Each test file exports { name, run(t) }; run_all.js drives them.

const assert = require("assert");

function makeContext(failures, fileName) {
  let count = 0;
  return {
    check(label, fn) {
      count++;
      try {
        fn(assert);
        process.stdout.write(`    ok  ${label}\n`);
      } catch (error) {
        failures.push(`${fileName}: ${label}: ${error.message}`);
        process.stdout.write(`  FAIL  ${label}\n        ${error.message}\n`);
      }
    },
    get count() {
      return count;
    },
  };
}

module.exports = { makeContext };
