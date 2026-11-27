// src/mining/step-sources.js — where VDF steps come from, behind one shape, and the loop that
// mines them. No page or worker here: a page, a node program or a test supplies the parts
// that are its own (a VDF server pool, a way to compute a step), and hears back through
// callbacks.
//
// A step source has `label` (shown beside each mined step) and `batches(signal)`, an async
// generator of step batches: arrays of [stepNumber, output (Uint8Array)], oldest first. It
// ends when it has no more steps, throws when it cannot go on, and stops promptly once
// `signal` (an AbortSignal) is aborted.

export class StepWait {
  /** Resolves after `ms`, or at once when `signal` is aborted (the caller then checks it). */
  static sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

export class ReplayStepSource {
  /** Steps already known (a block's own), one every `intervalMs`, the network's pace. */
  constructor({ steps, intervalMs = 1000, label = 'block' }) {
    Object.assign(this, { steps, intervalMs, label });
  }

  async *batches(signal) {
    for (const [index, step] of this.steps.entries()) {
      if (signal.aborted) return;
      if (index > 0) await StepWait.sleep(this.intervalMs, signal);
      if (signal.aborted) return;
      yield [step];
    }
  }
}

export class ServerStepSource {
  /**
   * Steps from VDF servers: polls `pool` (a VdfServerPool, or anything with
   * poll(afterStep) resolving { newest, newestFrom, fresh, gapFilled, missing }) every
   * `pollIntervalMs` once the last batch is mined. Steps well behind the newest are stale,
   * so only the newest `maxBacklog` are given (at the start, and whenever mining falls
   * behind); the rest are counted as skipped.
   *
   * `lastMinedStep()` says where mining is (steps up to it are not given again).
   * `onPoll({ newest, newestFrom, gapFilled, missing, skipped, pollMs })` hears each poll;
   * `onError(error)` hears a failed poll, after which polling goes on.
   */
  constructor({ pool, lastMinedStep, pollIntervalMs, maxBacklog = 8, onPoll = () => {}, onError = () => {}, label = 'VDF server' }) {
    Object.assign(this, { pool, lastMinedStep, pollIntervalMs, maxBacklog, onPoll, onError, label });
  }

  async *batches(signal) {
    while (!signal.aborted) {
      try {
        const pollStarted = performance.now();
        const { newest, newestFrom, fresh, gapFilled, missing } = await this.pool.poll(this.lastMinedStep());
        const kept = fresh.slice(-this.maxBacklog);
        const skipped = this.lastMinedStep() >= 0 ? fresh.length - kept.length : 0;
        this.onPoll({ newest, newestFrom, gapFilled, missing, skipped, pollMs: performance.now() - pollStarted });
        if (kept.length && !signal.aborted) yield kept;
      } catch (error) {
        this.onError(error);
      }
      await StepWait.sleep(this.pollIntervalMs, signal);
    }
  }
}

export class ComputedStepSource {
  /**
   * Steps computed here, one after another from `start` ({ stepNumber, output }):
   * `computeStep({ stepNumber, previousOutput })` resolves { stepNumber, output,
   * checkpoints, seconds } (a worker, say). The next step is computed while this one is
   * mined. `onRequest(stepNumber, lastSeconds)` hears each request (lastSeconds: the
   * step before took that long, or null), `onComputed(result)` each result.
   */
  constructor({ computeStep, start, onRequest = () => {}, onComputed = () => {}, label = 'this tab' }) {
    Object.assign(this, { computeStep, start, onRequest, onComputed, label });
  }

  request(stepNumber, previousOutput, lastSeconds) {
    this.onRequest(stepNumber, lastSeconds);
    const pending = this.computeStep({ stepNumber, previousOutput });
    // Awaited below unless the loop stops first; then a late failure is nobody's to report.
    pending.catch(() => {});
    return pending;
  }

  async *batches(signal) {
    let pending = this.request(this.start.stepNumber + 1, this.start.output, null);
    while (!signal.aborted) {
      const result = await pending;
      if (signal.aborted) return;
      this.onComputed(result);
      pending = this.request(result.stepNumber + 1, result.output, result.seconds);
      yield [[result.stepNumber, result.output]];
    }
  }
}

export class StepMiningLoop {
  /**
   * Mines every step a source gives, one at a time, until the source ends or `stop()`.
   * `mineStep(stepNumber, output, label)` mines one. run() resolves { ended: 'stopped' }
   * after stop(), { ended: 'finished' } when the source ran out, or { ended: 'failed',
   * error } when it threw.
   */
  constructor({ source, mineStep }) {
    Object.assign(this, { source, mineStep });
    this.controller = new AbortController();
  }

  get running() {
    return !this.controller.signal.aborted;
  }

  stop() {
    this.controller.abort();
  }

  async run() {
    const { signal } = this.controller;
    try {
      for await (const batch of this.source.batches(signal)) {
        for (const [stepNumber, output] of batch) {
          if (signal.aborted) return { ended: 'stopped' };
          await this.mineStep(stepNumber, output, this.source.label);
        }
      }
      return { ended: signal.aborted ? 'stopped' : 'finished' };
    } catch (error) {
      return { ended: signal.aborted ? 'stopped' : 'failed', error };
    }
  }
}
