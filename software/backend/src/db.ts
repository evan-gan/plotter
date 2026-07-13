// Tiny JSON-file persistence. The Pi is the database: one JSON document per
// collection, written atomically (tmp + rename) so power loss can't corrupt.

import fs from "fs";
import path from "path";

export class JsonStore<T> {
  private filePath: string;
  private fallback: T;

  constructor(filePath: string, fallback: T) {
    this.filePath = filePath;
    this.fallback = fallback;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  load(): T {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as T;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        // Corrupt file: keep it for forensics, start fresh.
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.filePath, backup);
          console.error(`[db] ${this.filePath} was unreadable (${nodeError.message}); moved to ${backup}`);
        } catch {
          /* nothing else to do */
        }
      }
      return structuredClone(this.fallback);
    }
  }

  save(value: T): void {
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, this.filePath);
  }
}
