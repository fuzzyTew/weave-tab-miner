// test/held-storage.test.mjs — HeldStorage keeping chunks on disk: only `residentLimit`
// saved chunks stay in memory, any can be read back when a step needs it, and chunks not
// yet saved are never dropped. Run: node test/held-storage.test.mjs
import { ConsensusConstants } from '../src/core/constants.js';
import { HeldStorage } from '../src/mining/held-storage.js';
import { Replica29Layout } from '../src/mining/packing.js';
import { Miner } from '../src/mining/miner.js';
import { StubH0Hasher } from '../src/mining/mining-math.js';

class HeldStorageTest {
  run() {
    return this.check().then((failures) => { process.exitCode = failures ? 1 : 0; });
  }

  async check() {
    let failures = 0;
    const report = (name, passed, detail = '') => {
      if (!passed) failures++;
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    };
    const chunkSize = ConsensusConstants.DATA_CHUNK_SIZE;
    const base = ConsensusConstants.STRICT_DATA_SPLIT_THRESHOLD;
    const endOffset = (index) => base + BigInt((index + 1) * chunkSize);
    const chunkFor = (index) => new Uint8Array(chunkSize).fill(index + 1);
    const disk = new Map();
    let reads = 0;
    const storage = new HeldStorage({ residentLimit: 2, loadChunk: async (offset) => { reads++; return disk.get(offset.toString()) ?? null; } });

    for (let index = 0; index < 5; index++) {
      disk.set(endOffset(index).toString(), chunkFor(index));
      storage.add(endOffset(index), chunkFor(index), { reloadable: true });
    }
    report('only residentLimit saved chunks stay in memory', storage.residentCount === 2, `${storage.residentCount} of ${storage.packedChunks.size} in memory`);
    report('all of them still count as held', storage.byteCount === 5 * chunkSize);

    const byteInFirst = endOffset(0) - 1n;
    report('a dropped chunk reads as absent until loaded', storage.subChunkForByte(byteInFirst, 0) === null);
    await storage.ensureLoaded([byteInFirst]);
    report('ensureLoaded reads it back', storage.subChunkForByte(byteInFirst, 3)?.[0] === 1 && reads === 1, `${reads} read`);

    const unsaved = new HeldStorage({ residentLimit: 1, loadChunk: async () => null });
    for (let index = 0; index < 3; index++) unsaved.add(endOffset(index), chunkFor(index));
    report('unsaved chunks are never dropped', unsaved.residentCount === 3);
    unsaved.markReloadable([endOffset(0), endOffset(1)]);
    report('once saved, they may leave', unsaved.residentCount === 1);

    const onDisk = new HeldStorage({ loadChunk: async (offset) => disk.get(offset.toString()) });
    onDisk.addOnDisk(endOffset(4));
    report('a chunk known only on disk loads on demand', onDisk.subChunkForByte(Replica29Layout.bucketEndOffsetForByte(endOffset(4) - 1n) - 1n, 0) === null
      && (await onDisk.ensureLoaded([endOffset(4) - 1n]), onDisk.subChunkForByte(endOffset(4) - 1n, 0)?.[0] === 5));

    // A whole recall range held on disk, more chunks than may sit in memory: mining a step
    // must still try every nonce (it reads the range chunk by chunk).
    const chunksPerRange = ConsensusConstants.noncesPerRecallRange / ConsensusConstants.SUB_CHUNK_COUNT;
    const rangeDisk = new Map();
    let rangeReads = 0;
    const ranged = new HeldStorage({ residentLimit: 4, loadChunk: async (offset) => { rangeReads++; return rangeDisk.get(offset.toString()) ?? null; } });
    for (let index = 0; index < chunksPerRange; index++) {
      rangeDisk.set(endOffset(index).toString(), chunkFor(index));
      ranged.addOnDisk(endOffset(index));
    }
    const miner = new Miner({
      identity: { addressBytes: new Uint8Array(32) }, partitionNumber: 0, storage: ranged, h0Hasher: new StubH0Hasher(),
      testMode: { aimRange1AtHeldData: true, difficultyEase: 1 },
    });
    const stepReport = await miner.mineStep({ seed: new Uint8Array(48), partitionUpperBound: 10n ** 15n, networkDiff: (1n << 256n) - 1n }, 1, new Uint8Array(32));
    report(`a step over ${chunksPerRange} held chunks with room for 4 in memory tries every nonce`, stepReport.noncesTried === ConsensusConstants.noncesPerRecallRange && ranged.residentCount <= 4 + 2,
      `${stepReport.noncesTried} of ${ConsensusConstants.noncesPerRecallRange} tried, ${rangeReads} reads, ${ranged.residentCount} in memory after; ${stepReport.timings.totalMs.toFixed(0)} ms`);

    // Below the strict data split threshold chunks keep their own ends, off the bucket grid:
    // a byte is found in the first held chunk ending past it, within one chunk's size.
    const unaligned = new HeldStorage();
    const bucket = BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
    const ends = [1000n + bucket, 1000n + 2n * bucket, 1000n + 5n * bucket];
    ends.forEach((end, index) => unaligned.add(end, chunkFor(index)));
    report('below the threshold, a byte is found in the chunk holding it by its own end',
      unaligned.chunkForByte(1000n)?.[0] === 1 && unaligned.chunkForByte(1000n + bucket)?.[0] === 2
      && unaligned.chunkForByte(1000n + 2n * bucket) === null && unaligned.chunkForByte(1000n + 4n * bucket + 5n)?.[0] === 3
      && unaligned.chunkForByte(999n) === null);
    return failures;
  }
}

new HeldStorageTest().run();
