// Bridge to the battle-tested CommonJS libraries in firmware/tools/lib.
// The ETA engine, G-code timing parser, tuner state machine, and calibration
// harness already exist there (dependency-free, transport-agnostic), so the
// backend reuses them instead of re-implementing the physics.

import path from "path";
import { findRepoRoot } from "./config";

/* eslint-disable @typescript-eslint/no-var-requires */

const toolsLib = path.join(findRepoRoot(__dirname), "firmware", "tools", "lib");

export interface EtaBreakdown {
  seconds: number;
  motionSeconds: number;
  calibratedMotionSeconds: number;
  overheadSeconds: number;
  fixedSeconds: number;
  moveCount: number;
  penLifts: number;
  dwells: number;
  drawDistanceMm: number;
  travelDistanceMm: number;
}

interface EtaEngineModule {
  estimateEta(primitives: unknown[], config: Record<string, number>): EtaBreakdown;
  configFromSettings(settings: Record<string, number> | null, overrides?: object): Record<string, number>;
  DEFAULT_CONFIG: Record<string, number>;
}

interface GcodeParserModule {
  parseGcode(text: string, arcToleranceMm: number): unknown[];
}

interface CalibrationStoreModule {
  loadCalibration(): { motionScaler?: number; overheadPerMoveMs?: number; penMoveMs?: number } | null;
  saveCalibration(calibration: object): string;
}

export const etaEngine: EtaEngineModule = require(path.join(toolsLib, "eta-engine.js"));
export const gcodeParser: GcodeParserModule = require(path.join(toolsLib, "gcode-parser.js"));
export const calibrationStore: CalibrationStoreModule = require(path.join(toolsLib, "calibration-store.js"));

// Tuner + calibration harness are driven through an `io` object; the backend
// adapts them onto SSE events (see tuner.ts). Typed loosely on purpose —
// their contract is documented in firmware/tools/.
export const tuneEngine: {
  runSession(connection: unknown, options: { mode: string; tests: string; io: object }): Promise<void>;
} = require(path.join(toolsLib, "tune-engine.js"));

export const calibrateLib: {
  runCalibration(connection: unknown, options: { io: object; repeats?: number }): Promise<void>;
} = require(path.join(toolsLib, "calibrate.js"));
