// src/core/throughput-meter.js — a rate over a recent window: bytes a second, say, from
// amounts noted as they happen.

export class ThroughputMeter {
  /**
   * Notes amounts with the time they finished and reports their rate over the last
   * `windowMs`, counted from the first noted amount's start, so a single batch already
   * gives a rate. Pauses inside the window count as time (a fill that stopped and
   * started reads slower); `restart()` drops the history at a deliberate pause.
   */
  constructor({ windowMs = 10 * 60_000, now = () => performance.now() } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.samples = [];
    this.startedAt = null;
  }

  /** Marks the start of work whose amounts follow (the first batch's start). */
  start() {
    this.startedAt ??= this.now();
  }

  restart() {
    this.samples = [];
    this.startedAt = null;
  }

  note(amount) {
    const at = this.now();
    this.startedAt ??= at;
    this.samples.push({ at, amount });
    while (this.samples.length > 1 && at - this.samples[0].at > this.windowMs) {
      this.startedAt = this.samples.shift().at;
    }
  }

  /** Amount per second over the window, or null before any amount or elapsed time. */
  get perSecond() {
    if (!this.samples.length) return null;
    const elapsedMs = this.samples[this.samples.length - 1].at - this.startedAt;
    if (elapsedMs <= 0) return null;
    return this.samples.reduce((total, sample) => total + sample.amount, 0) / (elapsedMs / 1000);
  }
}
