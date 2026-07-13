"use strict";
// EtaService: offline estimates use firmware defaults; connected estimates
// read the board's live settings.

const { EventBus } = require("../../dist/events");
const { SerialManager } = require("../../dist/serial-manager");
const { EtaService } = require("../../dist/eta");

const PROGRAM = ["G21 G90", "M3", "G1 X100 Y0 F1500", "G1 X100 Y100", "M5", "G0 X0 Y0"].join("\n");

module.exports = {
  name: "eta service",
  run(t) {
    t.check("offline estimate works with firmware defaults", async (assert) => {
      const serial = new SerialManager({ simulate: false, preferredPort: "", bus: new EventBus() });
      const eta = new EtaService(serial); // never connected
      const breakdown = await eta.estimate(PROGRAM);
      assert.ok(breakdown.seconds > 0);
      assert.strictEqual(breakdown.liveSettings, false);
      assert.strictEqual(breakdown.moveCount, 3);
      assert.strictEqual(breakdown.penLifts, 2);
      assert.ok(Math.abs(breakdown.drawDistanceMm - 200) < 1e-6);
      assert.ok(Math.abs(breakdown.travelDistanceMm - Math.hypot(100, 100)) < 1e-6);
    });

    t.check("live settings from the (simulated) board shape the estimate", async (assert) => {
      const serial = new SerialManager({ simulate: true, preferredPort: "", bus: new EventBus() });
      const connection = await serial.ensure();
      await connection.sendLine("$110=750"); // halve the max feed
      const eta = new EtaService(serial);
      const slow = await eta.estimate(PROGRAM);
      assert.strictEqual(slow.liveSettings, true);
      await connection.sendLine("$110=1500");
      eta.invalidateSettingsCache();
      const fast = await eta.estimate(PROGRAM);
      assert.ok(slow.seconds > fast.seconds, `slow=${slow.seconds} fast=${fast.seconds}`);
    });
  },
};
