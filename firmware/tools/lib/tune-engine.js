"use strict";
// Speed/acceleration tuning engine — the logic ported verbatim (in intent)
// from the original tune.py. It is transport-agnostic: it drives the firmware
// through a Connection and talks to the operator through an `io` object, so the
// same engine works from a browser UI, a CLI, or a test harness.
//
// See firmware/TUNING.md for the *why* behind every number here. The short
// version: CoreXY loads the motors differently on axes vs. diagonals, so there
// are four caps to tune ($110/$112 speed, $120/$122 accel), and they must be
// tuned accel-first (C, D, A, B) or the speed tests read false ceilings.
//
// The `io` interface the caller must provide:
//   io.log(text)                 → human-readable progress line
//   io.verdict(context)          → Promise<"y"|"n"|"r"|"q"> operator judgement
//   io.settings(valuesObject)    → current persisted settings snapshot
//   io.summary(rows)             → final results table

// Caps pushed absurdly high so only the value under test can be the bottleneck.
const PUSH_SPEED = 3_000_000; // mm/min
const PUSH_ACCEL = 1_000_000; // mm/s²

// Firmware ISR caps step rate (MIN_STEP_INTERVAL_US=25 → 40 kHz → 500 mm/s →
// 30000 mm/min). Commanding faster is pointless — the ISR clamps and we'd read
// a false pass.
const ISR_MAX_SPEED = 30000; // mm/min

// ───────── test patterns ─────────
// Plain `M3` (no S) so we never overwrite the operator's calibrated $151 pen-down.

const patternA = (speed) => [
  `G1 X100 F${Math.round(speed)}`, "G1 X0",
  `G1 X100 F${Math.round(speed)}`, "G1 X0",
  `G1 X100 F${Math.round(speed)}`, "G1 X0",
];

const patternB = (speed) => [
  `G1 X50 Y50 F${Math.round(speed)}`, "G1 X0 Y0",
  `G1 X50 Y50 F${Math.round(speed)}`, "G1 X0 Y0",
  `G1 X50 Y50 F${Math.round(speed)}`, "G1 X0 Y0",
];

// Accel tests pin F at the ISR ceiling so the cruise cap never binds; v_peak
// ends up as √(a·L) (pure triangle), making every $120/$122 step audibly faster.
const patternC = () => [
  "G1 X20 F30000", "G1 X0",
  "G1 X20 F30000", "G1 X0",
  "G1 X20 F30000", "G1 X0",
];

const patternD = () => [
  "G1 X14 Y14 F30000", "G1 X0 Y0",
  "G1 X14 Y14 F30000", "G1 X0 Y0",
  "G1 X14 Y14 F30000", "G1 X0 Y0",
];

/** Wrap a motion pattern: zero origin, pen down, trace, pen up. */
function testBlock(patternLines) {
  return ["G21 G90", "M17", "G92 X0 Y0", "M3", "G4 P100", ...patternLines, "M5"];
}

/**
 * Commanded feedrate (mm/min) above which a move of `lengthMm` is accel-limited
 * and never actually reaches the requested speed (triangle profile
 * v_peak = √(a·L)). Beyond this, "faster" answers stop measuring the motor.
 */
function maxMeaningfulSpeed(accelMmS2, lengthMm) {
  return Math.sqrt(accelMmS2 * lengthMm) * 60.0;
}

async function streamBlock(connection, lines, io) {
  for (const line of lines) {
    if (!line.trim()) continue;
    const reply = await connection.sendLine(line, 15000);
    if (reply.startsWith("error")) io.log(`    ! [${line}] → ${reply}`);
  }
}

/**
 * Ramp one setting upward until the operator reports a failure, then save a
 * backed-off fraction of the last passing value.
 *
 * @returns {Promise<number|null>} the saved value, or null if nothing passed.
 */
async function runOneTest(connection, io, spec) {
  const {
    name, setting, patternFn, start, growth, minStep, backoff,
    accelMmS2 = null, effectiveLengthMm = null, hardCap = null,
  } = spec;

  io.log(`\n=== ${name} (${setting}) ===`);
  io.log(`Start ${start}, step ×${growth}.`);

  let meaningfulCeiling = null;
  if (accelMmS2 && effectiveLengthMm) {
    meaningfulCeiling = maxMeaningfulSpeed(accelMmS2, effectiveLengthMm);
    io.log(
      `(Accel-limited ceiling for this geometry: ~F${Math.round(meaningfulCeiling)}. ` +
        `Above that, commanded F is not the actual speed the motor sees.)`
    );
  }

  let value = start;
  let lastGood = null;
  let warnedCeiling = false;

  for (;;) {
    if (meaningfulCeiling && value > meaningfulCeiling && !warnedCeiling) {
      io.log(
        `  ! F${Math.round(value)} exceeds the accel-limited ceiling ` +
          `(~F${Math.round(meaningfulCeiling)}). Further "faster" answers are NOT ` +
          `measuring the motor — raise $120/$122 to go higher.`
      );
      warnedCeiling = true;
    }

    io.log(`Setting ${setting} = ${Math.round(value)}…`);
    if ((await connection.sendLine(`${setting}=${Math.round(value)}`)) !== "ok") {
      io.log(`  ! could not set ${setting}, aborting test`);
      break;
    }

    await streamBlock(connection, testBlock(patternFn(value)), io);
    try {
      await connection.waitIdle();
    } catch (err) {
      io.log(`  ! ${err.message}`);
      break;
    }

    const { mx, my } = await connection.status();
    io.log(`  MPos after test: (${mx.toFixed(3)}, ${my.toFixed(3)})`);

    const verdict = await io.verdict({
      test: name,
      setting,
      value: Math.round(value),
      mpos: { x: mx, y: my },
    });

    if (verdict === "q") {
      io.log("  quitting this test");
      break;
    }
    if (verdict === "r") continue;
    if (verdict === "y") {
      lastGood = value;
      value *= growth;
      if (hardCap && value > hardCap) {
        io.log(
          `  → Reached firmware ISR ceiling (${Math.round(hardCap)}); stopping ramp. ` +
            `The motor can't step faster without a MIN_STEP_INTERVAL_US change.`
        );
        break;
      }
      if (meaningfulCeiling && value > meaningfulCeiling) {
        io.log(
          `  → Next F${Math.round(value)} exceeds the accel-limited ceiling ` +
            `(~F${Math.round(meaningfulCeiling)}) — the test can't distinguish it. Stopping ramp.`
        );
        break;
      }
    } else {
      break; // "n"
    }
  }

  if (lastGood === null) {
    io.log(`  ! No passing value found for ${setting}.`);
    return null;
  }
  const final = Math.max(Math.round(minStep), Math.round(lastGood * backoff));
  io.log(
    `  → Last passing ${setting} = ${Math.round(lastGood)}. ` +
      `Saving ${Math.round(backoff * 100)}% → ${final}.`
  );
  await connection.sendLine(`${setting}=${final}`);
  return final;
}

/**
 * Run a full tuning session over the requested subset of tests.
 *
 * @param {Connection} connection Open serial connection to the firmware.
 * @param {object} options { mode: "coarse"|"fine", tests: "CDAB", io }
 */
async function runSession(connection, { mode = "coarse", tests = "CDAB", io }) {
  const fine = mode === "fine";
  const growth = fine ? 1.1 : 1.5;
  const backoff = fine ? 0.9 : 0.8;
  const startFrac = fine ? 0.95 : 1.0;
  const startFloor = fine ? 0 : 5000; // coarse skips obviously-passing low values

  // Probe firmware identity.
  await connection.sendLine("$I");
  // Snapshot original settings so we can restore anything we push but don't tune.
  const orig = await connection.settings();
  io.settings(orig);

  const requested = tests.toUpperCase();
  const startFor = (key) =>
    Math.max(startFloor, Math.round((orig[key] ?? 5000) * startFrac));

  io.log("Marking origin dot — all tests should return the pen to this point.");
  await streamBlock(
    connection,
    ["M17", "G21 G90", "G92 X0 Y0", "M3", "G4 P400", "M5"],
    io
  );
  await connection.waitIdle();

  const results = {}; // { "$110": value } for tests that found a value
  const touched = new Set(); // settings we mutated as a prereq; may need restore

  const pushSpeed = (key) =>
    connection.sendLine(`${key}=${Math.max(PUSH_SPEED, Math.round(orig[key] ?? 1500))}`);
  const pushAccel = (key) =>
    connection.sendLine(`${key}=${Math.max(PUSH_ACCEL, Math.round(orig[key] ?? 500))}`);

  try {
    // Test C — $120 axis accel. Push both speed caps and the diagonal accel cap.
    if (requested.includes("C")) {
      ["$110", "$112", "$122"].forEach((k) => touched.add(k));
      await pushSpeed("$110");
      await pushSpeed("$112");
      await pushAccel("$122");
      results["$120"] = await runOneTest(connection, io, {
        name: "Test C: axis-aligned accel", setting: "$120", patternFn: patternC,
        start: startFor("$120"), growth, minStep: 200, backoff,
      });
    }

    // Test D — $122 diagonal accel. Push both speed caps and the axis accel cap.
    if (requested.includes("D")) {
      ["$110", "$112", "$120"].forEach((k) => touched.add(k));
      await pushSpeed("$110");
      await pushSpeed("$112");
      await pushAccel("$120");
      results["$122"] = await runOneTest(connection, io, {
        name: "Test D: diagonal accel", setting: "$122", patternFn: patternD,
        start: startFor("$122"), growth, minStep: 200, backoff,
      });
    }

    // Test A — $110 axis speed. Keep accel at tuned/safe values, push $112.
    if (requested.includes("A")) {
      ["$120", "$122", "$112"].forEach((k) => touched.add(k));
      const axisAccel = results["$120"] ?? Math.round(orig["$120"] ?? 500);
      const diagAccel = results["$122"] ?? Math.round(orig["$122"] ?? 500);
      await connection.sendLine(`$120=${axisAccel}`);
      await connection.sendLine(`$122=${diagAccel}`);
      await pushSpeed("$112");
      results["$110"] = await runOneTest(connection, io, {
        name: "Test A: axis-aligned speed", setting: "$110", patternFn: patternA,
        start: startFor("$110"), growth, minStep: 1500, backoff,
        accelMmS2: axisAccel, effectiveLengthMm: 100.0, hardCap: ISR_MAX_SPEED,
      });
    }

    // Test B — $112 diagonal speed. Push $110. On a 45° diagonal the Cartesian
    // accel is $122/√2 and the (50,50) move length is √(50²+50²) ≈ 70.7 mm.
    if (requested.includes("B")) {
      ["$120", "$122", "$110"].forEach((k) => touched.add(k));
      const axisAccel = results["$120"] ?? Math.round(orig["$120"] ?? 500);
      const diagAccel = results["$122"] ?? Math.round(orig["$122"] ?? 500);
      await connection.sendLine(`$120=${axisAccel}`);
      await connection.sendLine(`$122=${diagAccel}`);
      await pushSpeed("$110");
      results["$112"] = await runOneTest(connection, io, {
        name: "Test B: diagonal speed", setting: "$112", patternFn: patternB,
        start: startFor("$112"), growth, minStep: 1500, backoff,
        accelMmS2: diagAccel / Math.sqrt(2.0), effectiveLengthMm: 70.7,
        hardCap: ISR_MAX_SPEED,
      });
    }
  } finally {
    // Re-write every touched setting to its correct final value: tuned value if
    // we tuned it, else the pre-run snapshot. This also clears any push sentinel
    // a later test's prereq left in a cap an earlier test had already tuned.
    for (const key of ["$110", "$112", "$120", "$122"]) {
      if (!touched.has(key) && results[key] === undefined) continue;
      const desired = results[key] != null ? results[key] : orig[key];
      if (desired == null) continue;
      io.log(`  writing ${key} = ${Math.round(desired)}`);
      await connection.sendLine(`${key}=${Math.round(desired)}`);
    }

    // $111 (rapid) is untested — keep travel at least as fast as feed moves but
    // never above the tuned motor-rate cap.
    const final110 = results["$110"] ?? orig["$110"] ?? 1500;
    const final112 = results["$112"] ?? orig["$112"] ?? 1500;
    const target111 = Math.min(final112, Math.max(final110, orig["$111"] ?? 1500));
    await connection.sendLine(`$111=${Math.round(target111)}`);

    // Pen up + motors off, whatever happened.
    await connection.sendLine("M5");
    await connection.sendLine("M18");
  }

  // Final summary.
  const finalSettings = await connection.settings();
  io.settings(finalSettings);
  const rows = ["$110", "$111", "$112", "$120", "$122"]
    .filter((key) => finalSettings[key] !== undefined)
    .map((key) => ({
      setting: key,
      value: Math.round(finalSettings[key]),
      was: orig[key] != null ? Math.round(orig[key]) : null,
      tuned: results[key] != null,
    }));
  io.summary(rows);
  return rows;
}

module.exports = { runSession, ISR_MAX_SPEED };
