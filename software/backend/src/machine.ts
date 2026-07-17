// Direct machine controls for the admin panel: jog, set-home, stepper
// enable/disable, settings read/write, reset, and the diagnostic shapes
// (test circles + backlash cross, same programs as the standalone tuner).

import { SerialManager } from "./serial-manager";
import { EventBus } from "./events";
import { MachineLock } from "./machine-lock";
import { EtaService } from "./eta";
import { PlotRefeedService } from "./refeed";

const CIRCLE_FEED_MM_MIN = 750;
// Motion settings whose change should refeed queued jobs: $110/$112 (feed caps)
// change the draw speed; $111 (rapid) and $120-$122 (accel) change ETAs.
const MOTION_SETTING_KEYS = new Set(["$110", "$111", "$112", "$120", "$121", "$122"]);
// Jog always commands an explicit feedrate (like the tuner's shape programs)
// rather than a bare G0. A bare G0 depends on the board's $111/$110 max-rate
// settings being nonzero; if they've been zeroed by a bad tune/reset the move
// plans at 0 speed and never steps, so the head silently doesn't move. The
// firmware clamps this down to the machine's real max, so it's safe to ask high.
const JOG_FEED_MM_MIN = 1500;

/** 20 mm test circle about (10,10) via the firmware's on-device G2 arc. */
function circleGcode(feed?: number): string[] {
  return [
    "G21 G90",
    "M17",
    "G92 X0 Y0",
    "G0 X10 Y0",
    ...(feed ? [`G1 F${feed}`] : []),
    "M3",
    "G4 P100",
    feed ? `G2 X10 Y0 I0 J10 F${feed}` : "G2 X10 Y0 I0 J10",
    "M5",
    "G0 X0 Y0",
    "M18",
  ];
}

/** Four out-and-back strokes from one centre; doubled lines reveal backlash. */
function backlashGcode(): string[] {
  const center = 15;
  const arm = 12;
  const lines = ["G21 G90", "M17", "G92 X0 Y0", `G0 X${center} Y${center}`, "G1 F400"];
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    lines.push("M3", "G4 P100");
    lines.push(`G1 X${(center + dx * arm).toFixed(2)} Y${(center + dy * arm).toFixed(2)}`);
    lines.push(`G1 X${center} Y${center}`);
    lines.push("M5");
  }
  lines.push("G0 X0 Y0", "M18");
  return lines;
}

export class MachineService {
  private serial: SerialManager;
  private bus: EventBus;
  private lock: MachineLock;
  private eta: EtaService;
  private refeed: PlotRefeedService;

  constructor(
    serial: SerialManager, bus: EventBus, lock: MachineLock, eta: EtaService, refeed: PlotRefeedService
  ) {
    this.serial = serial;
    this.bus = bus;
    this.lock = lock;
    this.eta = eta;
    this.refeed = refeed;
  }

  /** Refeed queued jobs to the current tuned feed, logging any failure. */
  private triggerRefeed(): void {
    this.refeed
      .refresh()
      .catch((error) => this.bus.log(`! Refeed after settings change failed: ${(error as Error).message}`));
  }

  async status() {
    if (!this.serial.isConnected) {
      return { connected: false, port: this.serial.portDescription, state: "Disconnected", mx: 0, my: 0 };
    }
    const connection = await this.serial.ensure();
    const machineStatus = await connection.status();
    return { connected: true, port: connection.description, ...machineStatus };
  }

  async connect() {
    const connection = await this.serial.ensure();
    return { connected: true, port: connection.description };
  }

  /** Relative jog. The G91/G90 pair keeps the board's modal state absolute. */
  async jog(dxMm: number, dyMm: number, feedMmMin?: number): Promise<void> {
    if (!Number.isFinite(dxMm) || !Number.isFinite(dyMm) || Math.abs(dxMm) > 200 || Math.abs(dyMm) > 200) {
      throw new Error("Jog distance must be a number within ±200 mm.");
    }
    this.lock.acquire("jogging");
    try {
      const connection = await this.serial.ensure();
      await this.sendChecked(connection, "M17");
      await this.sendChecked(connection, "G91");
      const feed = feedMmMin && feedMmMin > 0 ? feedMmMin : JOG_FEED_MM_MIN;
      await this.sendChecked(connection, `G1 X${dxMm} Y${dyMm} F${feed}`);
      await this.sendChecked(connection, "G90");
      await connection.waitIdle(30_000);
    } finally {
      this.lock.release("jogging");
    }
  }

  /** Make the current position the origin (hand-home workflow). */
  async setHome(): Promise<void> {
    const connection = await this.serial.ensure();
    await this.sendChecked(connection, "M17");
    await this.sendChecked(connection, "G92 X0 Y0");
    // The firmware's `?` keeps reporting machine position after a G92, so mirror
    // the new work origin host-side — this is what snaps the UI marker to (0,0).
    await connection.captureWorkOrigin();
    this.bus.log("Zeroed — this position is now X0 Y0.");
  }

  async setSteppers(enabled: boolean): Promise<void> {
    const connection = await this.serial.ensure();
    await this.sendChecked(connection, enabled ? "M17" : "M18");
    this.bus.log(enabled ? "Steppers enabled." : "Steppers released — move the head by hand, then set home.");
  }

  async penUpDown(down: boolean): Promise<void> {
    const connection = await this.serial.ensure();
    await this.sendChecked(connection, down ? "M3" : "M5");
  }

  async getSettings(): Promise<Record<string, number>> {
    const connection = await this.serial.ensure();
    return connection.settings();
  }

  async setSetting(key: string, value: number): Promise<Record<string, number>> {
    if (!/^\$\d+$/.test(key) || !Number.isFinite(value)) {
      throw new Error("Setting must look like $110 with a numeric value.");
    }
    const connection = await this.serial.ensure();
    const reply = await connection.sendLine(`${key}=${value}`, 5000);
    if (reply !== "ok") throw new Error(`${key}=${value} → ${reply}`);
    this.eta.invalidateSettingsCache();
    this.bus.log(`Setting ${key}=${value} saved to the board.`);
    // Read settings back before kicking off refeed — the shared connection
    // doesn't serialize `$$` dumps, so two in flight would corrupt each other.
    const settings = await connection.settings();
    if (MOTION_SETTING_KEYS.has(key)) this.triggerRefeed();
    return settings;
  }

  async resetDefaults(): Promise<Record<string, number>> {
    const connection = await this.serial.ensure();
    const reply = await connection.sendLine("$RST=*", 15000);
    if (reply !== "ok") throw new Error(`$RST=* → ${reply}`);
    this.eta.invalidateSettingsCache();
    this.bus.log("Firmware defaults restored ($RST=*).");
    const settings = await connection.settings();
    this.triggerRefeed();
    return settings;
  }

  /** Draw a named diagnostic shape. Runs under the machine lock. */
  async drawShape(shape: "circle" | "slow-circle" | "max-circle" | "backlash"): Promise<void> {
    const connection = await this.serial.ensure();
    let lines: string[];
    let label: string;
    if (shape === "circle") {
      lines = circleGcode(CIRCLE_FEED_MM_MIN);
      label = "20 mm test circle";
    } else if (shape === "slow-circle") {
      lines = circleGcode(300);
      label = "slow circle (300 mm/min)";
    } else if (shape === "max-circle") {
      const settings = await connection.settings();
      const feed = settings["$110"] > 0 ? settings["$110"] : CIRCLE_FEED_MM_MIN;
      lines = circleGcode(feed);
      label = `circle at max feed (${Math.round(feed)} mm/min)`;
    } else {
      lines = backlashGcode();
      label = "backlash cross";
    }

    this.lock.acquire(`drawing ${label}`);
    try {
      this.bus.log(`Drawing ${label}…`);
      for (const line of lines) {
        const reply = await connection.sendLine(line, 60_000);
        if (reply !== "ok") this.bus.log(`  ! [${line}] → ${reply}`);
      }
      await connection.waitIdle();
      this.bus.log(`${label} done.`);
    } finally {
      this.lock.release(`drawing ${label}`);
    }
  }

  private async sendChecked(connection: Awaited<ReturnType<SerialManager["ensure"]>>, line: string): Promise<void> {
    const reply = await connection.sendLine(line, 10_000);
    if (reply !== "ok") throw new Error(`"${line}" → ${reply}`);
  }
}
