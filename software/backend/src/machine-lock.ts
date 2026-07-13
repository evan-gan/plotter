// One mutex for everything that commands motion (plot runner, tuner, shapes,
// calibration, jog). Two of those running interleaved would corrupt both.

export class MachineLock {
  private holder: string | null = null;

  /** Take the lock or throw with a message naming the current holder. */
  acquire(who: string): void {
    if (this.holder) {
      throw new Error(`Machine is busy (${this.holder}). Wait for it to finish or abort it first.`);
    }
    this.holder = who;
  }

  release(who: string): void {
    if (this.holder === who) this.holder = null;
  }

  get busyWith(): string | null {
    return this.holder;
  }
}
