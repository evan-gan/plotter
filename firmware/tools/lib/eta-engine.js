"use strict";
// Transport-agnostic ETA engine: integrates the total run time of a G-code
// program by replicating the firmware's motion model offline.
//
// It mirrors three firmware modules so the estimate tracks real behaviour:
//   * kinematics.h  — the CoreXY motor-load factor that caps per-direction
//                     speed and acceleration. The factor max(|ux+uy|,|ux-uy|)
//                     is layout-independent, so this works for any COREXY_LAYOUT.
//   * planner.cpp   — per-block nominal-speed/accel clamping, junction-deviation
//                     corner speeds, and the backward/forward look-ahead pass
//                     that resolves each block's entry speed.
//   * stepper.cpp   — trapezoidal time per block, plus the fixed pen-servo dwell.
//
// The one deliberate simplification: the firmware's 16-block planner buffer is
// treated as unbounded here. That only matters if serial can't feed blocks fast
// enough to keep the buffer full; for a pre-buffered file the motion profile is
// identical, so the estimate is an accurate lower-ish bound on wall-clock time.

/**
 * CoreXY motor load for a unit direction. Equals max(|ux+uy|, |ux-uy|):
 * 1 for pure X/Y, √2 at 45°. Identical for all four belt layouts, so the
 * estimate needs no knowledge of COREXY_LAYOUT.
 */
function motorLoad(unitX, unitY) {
  return Math.max(Math.abs(unitX + unitY), Math.abs(unitX - unitY));
}

/**
 * GRBL junction speed: the max tip speed (mm/s) that can round the corner
 * between two unit vectors without exceeding `accel`. Mirrors junction_speed()
 * in planner.cpp.
 */
function junctionSpeed(prevUnit, nextUnit, accel, junctionDeviationMm) {
  const cosTheta = -(prevUnit[0] * nextUnit[0] + prevUnit[1] * nextUnit[1]);
  if (cosTheta <= -0.999999) return Infinity; // near-straight: no limit
  if (cosTheta >= 0.999999) return 0; // full reversal: must stop
  const sinHalf = Math.sqrt(0.5 * (1 - cosTheta));
  const vSquared = (accel * junctionDeviationMm * sinHalf) / (1 - sinHalf);
  return Math.sqrt(vSquared);
}

/**
 * Build the per-move motion blocks (length, unit vector, capped nominal speed
 * and accel, junction-limited max entry speed). Pen/dwell primitives become
 * hard stops: they break velocity continuity, so the block before exits at 0
 * and the block after enters at 0 — exactly what the firmware's sync blocks do.
 *
 * @returns {{blocks: object[], fixedSeconds: number}}
 */
function buildBlocks(primitives, config) {
  const blocks = [];
  let fixedSeconds = 0;
  let position = { x: 0, y: 0 };
  let prevUnit = null; // null after a sync stop or at the start

  for (const primitive of primitives) {
    if (primitive.type === "pen") {
      fixedSeconds += config.penMoveMs / 1000;
      prevUnit = null;
      continue;
    }
    if (primitive.type === "dwell") {
      fixedSeconds += primitive.ms / 1000;
      prevUnit = null;
      continue;
    }
    const block = makeMoveBlock(position, primitive, config, prevUnit);
    position = { x: primitive.x, y: primitive.y };
    if (!block) continue; // zero-length move, dropped like the firmware does
    blocks.push(block);
    prevUnit = block.unit;
  }
  return { blocks, fixedSeconds };
}

/** Construct one move block, or null for a zero-length move. */
function makeMoveBlock(position, primitive, config, prevUnit) {
  const deltaX = primitive.x - position.x;
  const deltaY = primitive.y - position.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length < 1e-6) return null;

  const unit = [deltaX / length, deltaY / length];
  const load = motorLoad(unit[0], unit[1]);

  const desiredMmMin = primitive.rapid
    ? config.maxRapidMmMin
    : primitive.feedMmMin > 0
      ? primitive.feedMmMin
      : config.maxFeedrateMmMin;

  const capUser = config.maxFeedrateMmMin / 60;
  const capMotor = load > 1e-6 ? config.motorMaxRateMmMin / 60 / load : capUser;
  const nominalSpeed = Math.min(desiredMmMin / 60, capUser, capMotor);

  const accelCapMotor = load > 1e-6 ? config.motorMaxAccelMmS2 / load : config.maxAccelMmS2;
  const acceleration = Math.min(config.maxAccelMmS2, accelCapMotor);

  let maxEntrySpeed = prevUnit ? junctionSpeed(prevUnit, unit, acceleration, config.junctionDeviationMm) : 0;
  if (maxEntrySpeed > nominalSpeed) maxEntrySpeed = nominalSpeed;

  return { length, unit, nominalSpeed, acceleration, maxEntrySpeed, entrySpeed: 0 };
}

/**
 * Resolve entry speeds across all blocks with the same two-pass look-ahead the
 * planner uses, then integrate each block's trapezoidal time.
 *
 * @returns {number} Total motion time in seconds (excludes fixed dwells).
 */
function integrateMotion(blocks) {
  if (blocks.length === 0) return 0;

  // Backward pass: each block must be able to decelerate to the next block's
  // entry speed within its own length. The last block decelerates to a stop.
  blocks[blocks.length - 1].entrySpeed = Math.min(
    blocks[blocks.length - 1].maxEntrySpeed,
    blocks[blocks.length - 1].nominalSpeed
  );
  for (let index = blocks.length - 2; index >= 0; index--) {
    const current = blocks[index];
    const exitSpeed = blocks[index + 1].entrySpeed;
    const reachable = Math.sqrt(exitSpeed * exitSpeed + 2 * current.acceleration * current.length);
    current.entrySpeed = Math.min(current.maxEntrySpeed, current.nominalSpeed, reachable);
  }

  // Forward pass: no block can enter faster than the previous one could
  // accelerate it to over the previous block's length.
  for (let index = 0; index < blocks.length - 1; index++) {
    const current = blocks[index];
    const reachable = Math.sqrt(current.entrySpeed * current.entrySpeed + 2 * current.acceleration * current.length);
    if (blocks[index + 1].entrySpeed > reachable) blocks[index + 1].entrySpeed = reachable;
  }

  let seconds = 0;
  for (let index = 0; index < blocks.length; index++) {
    const exitSpeed = index + 1 < blocks.length ? blocks[index + 1].entrySpeed : 0;
    seconds += trapezoidTime(blocks[index], exitSpeed);
  }
  return seconds;
}

/**
 * Time (seconds) to traverse one block given its resolved entry speed and the
 * next block's entry speed as its exit speed. Mirrors compute_trapezoid():
 * accelerate toward nominal, cruise, decelerate — collapsing to a triangle
 * when the length is too short to reach nominal.
 */
function trapezoidTime(block, exitSpeed) {
  const { length, entrySpeed, nominalSpeed, acceleration } = block;
  const inv2a = 0.5 / acceleration;
  let distAccel = (nominalSpeed * nominalSpeed - entrySpeed * entrySpeed) * inv2a;
  let distDecel = (nominalSpeed * nominalSpeed - exitSpeed * exitSpeed) * inv2a;
  if (distAccel < 0) distAccel = 0;
  if (distDecel < 0) distDecel = 0;
  let distCruise = length - distAccel - distDecel;

  let peakSpeed = nominalSpeed;
  if (distCruise < 0) {
    // Triangle profile: never reaches nominal. Solve for the achievable peak.
    let peakSq = (2 * acceleration * length + entrySpeed * entrySpeed + exitSpeed * exitSpeed) * 0.5;
    peakSq = Math.max(peakSq, entrySpeed * entrySpeed, exitSpeed * exitSpeed);
    peakSpeed = Math.sqrt(peakSq);
    distAccel = Math.min(length, Math.max(0, (peakSq - entrySpeed * entrySpeed) * inv2a));
    distDecel = length - distAccel;
    distCruise = 0;
  }

  const timeAccel = (peakSpeed - entrySpeed) / acceleration;
  const timeDecel = (peakSpeed - exitSpeed) / acceleration;
  const timeCruise = peakSpeed > 1e-9 ? distCruise / peakSpeed : 0;
  return timeAccel + timeCruise + timeDecel;
}

/**
 * Estimate total run time for a parsed G-code program.
 *
 * @param {object[]} primitives Output of parseGcode().
 * @param {object} config Motion config (see DEFAULT_CONFIG for the field list).
 * @returns {{seconds: number, motionSeconds: number, fixedSeconds: number,
 *            moveCount: number, penLifts: number, dwells: number,
 *            drawDistanceMm: number, travelDistanceMm: number}}
 */
function estimateEta(primitives, config) {
  const { blocks, fixedSeconds } = buildBlocks(primitives, config);
  const motionSeconds = integrateMotion(blocks);
  const { drawDistanceMm, travelDistanceMm } = summariseDistances(primitives);

  // Calibration knobs (see lib/calibrate.js). Defaults are identity, so an
  // uncalibrated estimate is the pure physics model. motionScaler corrects a
  // systematic speed bias; overheadPerMoveMs adds per-segment serial/planner
  // cost the physics model doesn't capture (dominant on many-short-move paths).
  const motionScaler = config.motionScaler ?? 1;
  const overheadPerMoveMs = config.overheadPerMoveMs ?? 0;
  const calibratedMotionSeconds = motionScaler * motionSeconds;
  const overheadSeconds = (overheadPerMoveMs / 1000) * blocks.length;

  return {
    seconds: calibratedMotionSeconds + fixedSeconds + overheadSeconds,
    motionSeconds,
    calibratedMotionSeconds,
    overheadSeconds,
    fixedSeconds,
    moveCount: blocks.length,
    penLifts: primitives.filter((p) => p.type === "pen").length,
    dwells: primitives.filter((p) => p.type === "dwell").length,
    drawDistanceMm,
    travelDistanceMm,
  };
}

/** Sum feed-move ("draw") vs. rapid ("travel") path length in mm. */
function summariseDistances(primitives) {
  let drawDistanceMm = 0;
  let travelDistanceMm = 0;
  let position = { x: 0, y: 0 };
  for (const primitive of primitives) {
    if (primitive.type !== "move") continue;
    const length = Math.hypot(primitive.x - position.x, primitive.y - position.y);
    if (primitive.rapid) travelDistanceMm += length;
    else drawDistanceMm += length;
    position = { x: primitive.x, y: primitive.y };
  }
  return { drawDistanceMm, travelDistanceMm };
}

// Firmware compile-time defaults (config.h). Used when a live `$$` read isn't
// available. penMoveMs is DEFAULT_PEN_MOVE_MS and is NOT reported by `$$`.
const DEFAULT_CONFIG = {
  maxFeedrateMmMin: 1500,
  maxRapidMmMin: 1500,
  motorMaxRateMmMin: 1500,
  maxAccelMmS2: 200,
  motorMaxAccelMmS2: 500,
  junctionDeviationMm: 0.05,
  arcToleranceMm: 0.002,
  penMoveMs: 150,
  // Calibration knobs — identity by default (uncalibrated physics estimate).
  motionScaler: 1,
  overheadPerMoveMs: 0,
};

/**
 * Map a parsed `$$` settings object (e.g. from Connection.settings()) onto the
 * engine's config, falling back to firmware defaults for anything missing.
 *
 * @param {Record<string,number>|null} settings Parsed `$$` dump, or null.
 * @param {object|number} overrides Either a bare penMoveMs number (legacy) or
 *   an object of { penMoveMs, motionScaler, overheadPerMoveMs } overrides —
 *   typically a loaded eta-calibration.json.
 */
function configFromSettings(settings, overrides = {}) {
  const opts = typeof overrides === "number" ? { penMoveMs: overrides } : overrides || {};
  const pick = (key, fallback) => (settings && settings[key] !== undefined ? settings[key] : fallback);
  return {
    maxFeedrateMmMin: pick("$110", DEFAULT_CONFIG.maxFeedrateMmMin),
    maxRapidMmMin: pick("$111", DEFAULT_CONFIG.maxRapidMmMin),
    motorMaxRateMmMin: pick("$112", DEFAULT_CONFIG.motorMaxRateMmMin),
    maxAccelMmS2: pick("$120", DEFAULT_CONFIG.maxAccelMmS2),
    motorMaxAccelMmS2: pick("$122", DEFAULT_CONFIG.motorMaxAccelMmS2),
    junctionDeviationMm: pick("$140", pick("$11", DEFAULT_CONFIG.junctionDeviationMm)),
    arcToleranceMm: pick("$141", pick("$12", DEFAULT_CONFIG.arcToleranceMm)),
    penMoveMs: opts.penMoveMs ?? DEFAULT_CONFIG.penMoveMs,
    motionScaler: opts.motionScaler ?? DEFAULT_CONFIG.motionScaler,
    overheadPerMoveMs: opts.overheadPerMoveMs ?? DEFAULT_CONFIG.overheadPerMoveMs,
  };
}

module.exports = {
  estimateEta,
  buildBlocks,
  integrateMotion,
  trapezoidTime,
  motorLoad,
  junctionSpeed,
  configFromSettings,
  DEFAULT_CONFIG,
};
