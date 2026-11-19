// test/odds.test.mjs — checks the wait estimate's arithmetic: the compounding factors multiply
// back to the expected wait, and the range-hit chance matches the simple cases worked out
// by hand (one chunk; a contiguous run; chunks spread out). Run: node test/odds.test.mjs
import { readFileSync } from 'node:fs';
import { ConsensusConstants } from '../src/core/constants.js';
import { HeldStorage } from '../src/mining/held-storage.js';
import { SolutionOdds } from '../src/mining/odds.js';
import { VdfSession } from '../src/mining/vdf.js';

class OddsTest {
  constructor() {
    this.failures = 0;
    this.session = VdfSession.fromBlock(JSON.parse(readFileSync(new URL('../data/sample-block.json', import.meta.url), 'utf8')));
  }

  report(name, passed, detail) {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  }

  /** Storage holding chunks whose 256 KiB buckets end at the given offsets in partition 0. */
  storageWithChunkEnds(ends) {
    const storage = new HeldStorage();
    for (const end of ends) storage.add(BigInt(end), new Uint8Array(0));
    return storage;
  }

  run() {
    const chunk = ConsensusConstants.DATA_CHUNK_SIZE;
    const range = ConsensusConstants.recallRangeSize;
    const partition = Number(ConsensusConstants.PARTITION_SIZE);
    const close = (left, right) => Math.abs(left - right) <= 1e-9 * Math.max(Math.abs(left), Math.abs(right));

    // 10 GB held as one run of chunks, 5 GB in.
    const runChunks = Math.round(10e9 / chunk);
    const contiguous = this.storageWithChunkEnds(Array.from({ length: runChunks }, (_, index) => 5e9 + (index + 1) * chunk));
    const odds = { storage: contiguous, partitionNumber: 0, session: this.session, stepsPerSecond: 0.5 };
    const { factors, seconds } = SolutionOdds.waitBreakdown(odds);
    this.report('factors multiply back to the expected wait', close(seconds, SolutionOdds.expectedSecondsPerSolution(odds)),
      factors.map((factor) => `${factor.name} ×${factor.multiplier.toPrecision(3)}`).join(', '));

    const contiguousChance = SolutionOdds.heldRangeHitChance(odds);
    const contiguousExpected = (runChunks * chunk + range) / partition;
    this.report('a contiguous run: (run + range) / partition', close(contiguousChance, contiguousExpected), `once every ${(1 / contiguousChance).toFixed(0)} steps`);

    const one = SolutionOdds.heldRangeHitChance({ storage: this.storageWithChunkEnds([1e9]), partitionNumber: 0, session: this.session });
    this.report('one chunk: (chunk + range) / partition', close(one, (chunk + range) / partition), `${one.toExponential(3)}`);

    const spreadCount = 1000;
    const spread = this.storageWithChunkEnds(Array.from({ length: spreadCount }, (_, index) => (index + 1) * 3e9));
    const spreadChance = SolutionOdds.heldRangeHitChance({ storage: spread, partitionNumber: 0, session: this.session });
    this.report('spread chunks: count times one chunk chance', close(spreadChance, spreadCount * (chunk + range) / partition), `${spreadChance.toExponential(3)}`);
    process.exitCode = this.failures ? 1 : 0;
  }
}

new OddsTest().run();
