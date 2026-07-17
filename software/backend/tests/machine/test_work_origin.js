"use strict";
// Host-side work-origin tracking (connection.captureWorkOrigin + status).
//
// The real firmware's `?` only ever reports MACHINE position (MPos), which a
// G92 re-zero does NOT change. So the host must mirror the zero itself and
// report WORK position, or the UI marker never moves when you zero (and a plot
// that finishes at work X0 Y0 looks like it ends "wherever it is").
//
// The simulator moves its reported position on G92, masking this — so these
// tests drive a stub transport that reports a FIXED machine position, exactly
// as real hardware does after a G92.

const { BaseConnection } = require("../../dist/connection");

// A BaseConnection whose `?` always reports the same machine position,
// regardless of any G92 — this is how the real board behaves.
class FixedPositionConnection extends BaseConnection {
  constructor(machineX, machineY) {
    super();
    this.machineX = machineX;
    this.machineY = machineY;
    this.description = "fixed-stub";
  }
  sendRaw(data) {
    if (String(data).includes("?")) {
      setImmediate(() =>
        this.receiveLine(`<Idle|MPos:${this.machineX.toFixed(3)},${this.machineY.toFixed(3)}|FS:0,0>`)
      );
    }
  }
  sendLineRaw() {}
  async close() {}
}

exports.name = "host work-origin tracking";
exports.run = (context) => {
  context.check("status reports raw machine position before any zero", async (assert) => {
    const connection = new FixedPositionConnection(15, 7);
    const status = await connection.status();
    assert.strictEqual(status.mx, 15);
    assert.strictEqual(status.my, 7);
  });

  context.check("captureWorkOrigin makes the current position read as (0,0)", async (assert) => {
    // Simulates: operator jogs to a corner (machine 15,7), sends G92 X0 Y0.
    const connection = new FixedPositionConnection(15, 7);
    await connection.captureWorkOrigin();
    const status = await connection.status();
    assert.strictEqual(status.mx, 0);
    assert.strictEqual(status.my, 0);
  });

  context.check("a plot finishing at work X0 Y0 reads as the origin, not the raw MPos", async (assert) => {
    // After zeroing at machine (15,7), the firmware maps work (0,0) → machine
    // (15,7). A generated plot ends with G0 X0 Y0, so the head returns there;
    // reported WORK position must be (0,0), i.e. the origin marker.
    const connection = new FixedPositionConnection(15, 7);
    await connection.captureWorkOrigin();
    // Head is physically back at machine (15,7) after the finishing move.
    const status = await connection.status();
    assert.strictEqual(status.mx, 0);
    assert.strictEqual(status.my, 0);
  });

  context.check("a failed position read leaves the previous origin untouched", async (assert) => {
    const connection = new FixedPositionConnection(15, 7);
    await connection.captureWorkOrigin();
    // Now make `?` go silent so rawStatus times out (state "Unknown").
    connection.sendRaw = () => {};
    await connection.captureWorkOrigin(); // must be a no-op, not reset to garbage
    connection.sendRaw = (data) => {
      if (String(data).includes("?")) {
        setImmediate(() => connection.receiveLine("<Idle|MPos:15.000,7.000|FS:0,0>"));
      }
    };
    const status = await connection.status();
    assert.strictEqual(status.mx, 0);
    assert.strictEqual(status.my, 0);
  });
};
