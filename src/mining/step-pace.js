// src/mining/step-pace.js — how fast VDF steps reach the miner, where mining each one spends
// its time, and whether packing (which shares RandomX with H0) is slowing it.

export class StepPace {
  /**
   * Measures how many VDF steps a second actually reach the miner, over the last minute,
   * and where mining each one spent its time (Miner.mineStep's report.timings). A step
   * recorded with `packingBusy` began while packing had RandomX work queued, so its H0
   * may have waited for that work.
   */
  static WINDOW_MS = 60_000;

  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.arrivals = [];
  }

  record(timings = null, { packingBusy = false } = {}) {
    const at = this.now();
    this.arrivals.push({ at, timings, packingBusy });
    while (this.arrivals.length && at - this.arrivals[0].at > StepPace.WINDOW_MS) this.arrivals.shift();
  }

  reset() {
    this.arrivals = [];
  }

  stepsPerSecond(fallback) {
    if (this.arrivals.length < 3) return fallback;
    const spanSeconds = (this.arrivals.at(-1).at - this.arrivals[0].at) / 1000;
    return spanSeconds > 0 ? (this.arrivals.length - 1) / spanSeconds : fallback;
  }

  static meanTimings(timed) {
    const mean = (field) => timed.reduce((total, timings) => total + timings[field], 0) / timed.length;
    return { totalMs: mean('totalMs'), h0Ms: mean('h0Ms'), loadMs: mean('loadMs'), hashMs: mean('hashMs'), chunksRead: mean('chunksRead') };
  }

  /** Mean { totalMs, h0Ms, loadMs, hashMs, chunksRead } over the window, or null. */
  averageTimings() {
    const timed = this.arrivals.map((arrival) => arrival.timings).filter(Boolean);
    return timed.length ? StepPace.meanTimings(timed) : null;
  }

  /**
   * How packing slowed H0, or null when no step overlapped packing:
   * { busyShare (of timed steps), extraH0Ms (mean H0 with packing queued minus without, or
   * null when every step overlapped it), busyH0Ms }.
   */
  packingEffect() {
    const timed = this.arrivals.filter((arrival) => arrival.timings);
    const busy = timed.filter((arrival) => arrival.packingBusy);
    if (!busy.length) return null;
    const idle = timed.filter((arrival) => !arrival.packingBusy);
    const busyH0Ms = StepPace.meanTimings(busy.map((arrival) => arrival.timings)).h0Ms;
    const idleH0Ms = idle.length ? StepPace.meanTimings(idle.map((arrival) => arrival.timings)).h0Ms : null;
    return { busyShare: busy.length / timed.length, busyH0Ms, extraH0Ms: idleH0Ms === null ? null : busyH0Ms - idleH0Ms };
  }

  /**
   * One or two sentences: whether mining or the VDF source sets the pace (mining a step
   * faster than steps arrive means the source is the limit), and how much packing slowed it.
   */
  describe(fallbackStepsPerSecond) {
    const timings = this.averageTimings();
    if (!timings) return '';
    const secondsPerArrival = 1 / this.stepsPerSecond(fallbackStepsPerSecond);
    const limit = timings.totalMs / 1000 > secondsPerArrival * 0.9 ? 'mining is the limit here' : 'the VDF source is the limit, not mining';
    const pace = `Mining a step takes about ${Math.round(timings.totalMs)} ms (H0 ${Math.round(timings.h0Ms)} ms, reading ${timings.chunksRead.toFixed(1)} chunks from storage ${Math.round(timings.loadMs)} ms, hashing ${Math.round(timings.hashMs)} ms); steps arrive every ${secondsPerArrival.toFixed(2)} s, so ${limit}.`;
    const packing = this.packingEffect();
    if (!packing) return pace;
    const share = `${Math.round(packing.busyShare * 100)}% of steps`;
    const cost = packing.extraH0Ms === null ? `H0 took ${Math.round(packing.busyH0Ms)} ms with it` : `H0 took about ${Math.round(Math.max(0, packing.extraH0Ms))} ms longer then`;
    return `${pace} Packing shares RandomX with H0 and ran during ${share}; ${cost}. Mining gets the whole of RandomX once fetching stops.`;
  }
}
