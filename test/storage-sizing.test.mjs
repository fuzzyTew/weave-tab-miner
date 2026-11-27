// test/storage-sizing.test.mjs — StorageSizing's arithmetic, and a check that its measured
// index cost still holds for HeldStorage (so the page's memory estimate stays honest).
// Run: node --expose-gc test/storage-sizing.test.mjs (without --expose-gc the index check is skipped)
import { StorageSizing } from '../src/mining/storage-sizing.js';
import { HeldStorage } from '../src/mining/held-storage.js';
import { PrettyNumber } from '../src/core/pretty-number.js';
import { TestCase } from './test-case.mjs';

class StorageSizingTest extends TestCase {
  static TiB = 2 ** 40;
  static WEAVE_BYTES = 300e12;

  run() {
    const { TiB, WEAVE_BYTES } = StorageSizingTest;
    const full = new StorageSizing({ heldBytes: StorageSizing.partitionBytes, weaveBytes: WEAVE_BYTES });
    this.report('a full partition reads ten chunks of range 1 a step, plus its share of range 2',
      Math.abs(full.chunksReadPerStep - 10 * (1 + 3.6e12 / WEAVE_BYTES)) < 1e-9, full.chunksReadPerStep.toFixed(2));
    this.report('which is about 2.6 MB a second', Math.abs(full.readBytesPerSecond - full.chunksReadPerStep * 262144) < 1);
    this.report('a full partition indexes 1.1 GB in memory', Math.abs(full.indexMemoryBytes - 13_732_910 * 82) < 82 * 2, String(full.indexMemoryBytes));
    this.report('Chrome needs a disk of 6.7 TB for it', Math.abs(full.chromeDiskBytes - 3.6e12 / 0.54) < 1e6);
    this.report('fill time is unknown until measured', full.fillSeconds === null);

    const measuredFill = new StorageSizing({ heldBytes: TiB, weaveBytes: WEAVE_BYTES, measured: { fillBytesPerSecond: 2 ** 20, readMsPerChunk: null } });
    this.report('a measured fill rate gives a fill time, and null leaves the default', measuredFill.fillSeconds === 2 ** 20 && measuredFill.measured.readMsPerChunk === 1.5);

    const limits = full.limits();
    this.report('limits come smallest first', limits.every((limit, index) => index === 0 || limits[index - 1].bytes <= limit.bytes), limits.map((limit) => limit.name).join());
    this.report('on a fast disk reads never bind within a partition', limits.find((limit) => limit.name === 'reads').bytes === Infinity);
    const slowDisk = new StorageSizing({ heldBytes: 0, weaveBytes: WEAVE_BYTES, measured: { readMsPerChunk: 60 } });
    const readLimit = slowDisk.limits().find((limit) => limit.name === 'reads').bytes;
    this.report('a disk at 60 ms a chunk binds reads below a partition', readLimit < StorageSizing.partitionBytes && Math.abs(new StorageSizing({ heldBytes: readLimit, weaveBytes: WEAVE_BYTES, measured: { readMsPerChunk: 60 } }).readShareOfStep - 0.5) < 1e-6, PrettyNumber.bytes(readLimit));
    this.checkIndexCost();
    this.finish();
  }

  /** Measures HeldStorage's memory per chunk known on disk against the documented figure. */
  checkIndexCost() {
    if (!globalThis.gc) return console.log('SKIP  index cost (run with --expose-gc)');
    const chunkCount = 200_000;
    globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    const storage = new HeldStorage({ loadChunk: async () => null });
    let end = 180_000_000_000_000n;
    for (let index = 0; index < chunkCount; index++, end += 262144n) storage.addOnDisk(end);
    globalThis.gc();
    const perChunk = (process.memoryUsage().heapUsed - before) / chunkCount;
    // Use the storage after measuring, so it is not collected before the measurement.
    if (storage.packedChunks.size !== chunkCount) throw new Error('index lost chunks');
    this.report('HeldStorage costs within 25% of the documented bytes per chunk', Math.abs(perChunk / StorageSizing.MEASURED.indexBytesPerChunk - 1) < 0.25, `${perChunk.toFixed(0)} bytes`);
  }
}

new StorageSizingTest().run();
