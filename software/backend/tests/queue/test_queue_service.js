"use strict";
// QueueService: persistence, ordering, reorder validation, crash recovery.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { QueueService, sanitizeName } = require("../../dist/queue");

function freshService(dir) {
  return new QueueService(dir, () => {});
}

function addJob(service, name) {
  return service.add({
    name,
    source: "svg-upload",
    gcode: "G21\nG90\nM5\nG0 X0 Y0\n",
    previewSvg: "<svg xmlns='http://www.w3.org/2000/svg'/>",
    etaSeconds: 12,
    stats: null,
  });
}

module.exports = {
  name: "queue service",
  run(t) {
    t.check("add persists job + files, reload sees it", (assert) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
      const service = freshService(dir);
      const job = addJob(service, "First Drawing");
      assert.ok(fs.existsSync(service.gcodePath(job.id)));
      assert.ok(fs.existsSync(service.previewPath(job.id)));
      const reloaded = freshService(dir);
      assert.strictEqual(reloaded.list().length, 1);
      assert.strictEqual(reloaded.list()[0].name, "First Drawing");
      assert.strictEqual(reloaded.list()[0].lineCount, 4);
    });

    t.check("reorder rearranges queued jobs and validates ids", (assert) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
      const service = freshService(dir);
      const jobA = addJob(service, "a");
      const jobB = addJob(service, "b");
      const jobC = addJob(service, "c");
      service.reorder([jobC.id, jobA.id, jobB.id]);
      assert.deepStrictEqual(service.pending().map((job) => job.name), ["c", "a", "b"]);
      assert.throws(() => service.reorder([jobA.id]), /exactly the currently-queued/);
      assert.throws(() => service.reorder([jobA.id, jobB.id, "bogus"]), /exactly the currently-queued/);
    });

    t.check("remove deletes files; plotting jobs are protected", (assert) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
      const service = freshService(dir);
      const job = addJob(service, "victim");
      const gcodePath = service.gcodePath(job.id);
      service.update(job.id, { status: "plotting" });
      assert.throws(() => service.remove(job.id), /abort it first/);
      service.update(job.id, { status: "queued" });
      service.remove(job.id);
      assert.ok(!fs.existsSync(gcodePath));
      assert.strictEqual(service.list().length, 0);
    });

    t.check("jobs stuck plotting at startup become failed", (assert) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
      const service = freshService(dir);
      const job = addJob(service, "interrupted");
      service.update(job.id, { status: "plotting" });
      const reloaded = freshService(dir);
      const recovered = reloaded.get(job.id);
      assert.strictEqual(recovered.status, "failed");
      assert.match(recovered.error, /restarted/i);
    });

    t.check("sanitizeName strips dangerous characters", (assert) => {
      assert.strictEqual(sanitizeName('<script>"hi"</script>'), "scripthiscript");
      assert.strictEqual(sanitizeName("   "), "untitled");
      assert.ok(sanitizeName("x".repeat(200)).length <= 80);
    });
  },
};
