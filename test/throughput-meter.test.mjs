// test/throughput-meter.test.mjs — ThroughputMeter with a stand-in clock.
// Run: node test/throughput-meter.test.mjs
import { ThroughputMeter } from '../src/core/throughput-meter.js';
import { TestCase } from './test-case.mjs';

class ThroughputMeterTest extends TestCase {
  run() {
    let nowMs = 0;
    const meter = new ThroughputMeter({ windowMs: 10_000, now: () => nowMs });
    this.report('no rate before anything is noted', meter.perSecond === null);
    meter.start();
    nowMs = 2000;
    meter.note(4000);
    this.report('one batch after start gives its rate', meter.perSecond === 2000);
    nowMs = 4000;
    meter.note(4000);
    this.report('two batches over 4 s', meter.perSecond === 2000);
    nowMs = 20_000;
    meter.note(1000);
    this.report('old batches leave the window, which then starts at the last one dropped', meter.perSecond === 1000 / 16, String(meter.perSecond));
    meter.restart();
    this.report('restart forgets', meter.perSecond === null);
    this.finish();
  }
}

new ThroughputMeterTest().run();
