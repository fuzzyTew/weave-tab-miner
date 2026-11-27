// test/step-pace.test.mjs — StepPace with a stand-in clock: the pace, and how much packing
// slowed H0. Run: node test/step-pace.test.mjs
import { StepPace } from '../src/mining/step-pace.js';
import { TestCase } from './test-case.mjs';

class StepPaceTest extends TestCase {
  static timings(h0Ms) {
    return { totalMs: h0Ms + 100, h0Ms, loadMs: 20, hashMs: 80, chunksRead: 2 };
  }

  run() {
    let nowMs = 0;
    const pace = new StepPace({ now: () => nowMs });
    for (let step = 0; step < 10; step++) {
      nowMs += 1000;
      // Packing ran during the first four steps, making H0 300 ms slower.
      const packingBusy = step < 4;
      pace.record(StepPaceTest.timings(packingBusy ? 350 : 50), { packingBusy });
    }
    this.report('one step a second', Math.abs(pace.stepsPerSecond(0) - 1) < 1e-9);
    const effect = pace.packingEffect();
    this.report('packing ran during 40% of steps, 300 ms slower', Math.abs(effect.busyShare - 0.4) < 1e-9 && Math.abs(effect.extraH0Ms - 300) < 1e-9, JSON.stringify(effect));
    this.report('the description says so', pace.describe(1).includes('ran during 40% of steps; H0 took about 300 ms longer then'), pace.describe(1));
    const quiet = new StepPace({ now: () => nowMs });
    quiet.record(StepPaceTest.timings(50));
    this.report('without packing nothing is said of it', quiet.packingEffect() === null && !quiet.describe(1).includes('Packing'));
    this.finish();
  }
}

new StepPaceTest().run();
