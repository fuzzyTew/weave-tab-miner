// test/chunk-filler.test.mjs — ChunkFiller with a stand-in gateway (instant answers, some
// chunks missing) and all-zero entropy: it holds the chunks wanted in the partition, saves
// each batch and lets saved chunks leave memory, and stops early when told.
// Run: node test/chunk-filler.test.mjs
import { Bytes } from '../src/core/bytes.js';
import { ConsensusConstants } from '../src/core/constants.js';
import { MiningIdentity } from '../src/mining/identity.js';
import { HeldStorage } from '../src/mining/held-storage.js';
import { ChunkFiller } from '../src/network/chunk-filler.js';
import { TestCase } from './test-case.mjs';

class ChunkFillerTest extends TestCase {
  /**
   * One shared all-zero entropy: this test checks fetching, holding and saving, not
   * packing (test/randomx-against-block.test.mjs checks that), and computing even the
   * stand-in's 32 entropies of 8 MiB per batch took seconds.
   */
  static ZERO_ENTROPY = { isStub: true, entropy: async () => ChunkFillerTest.zeros };
  static zeros = new Uint8Array(ConsensusConstants.REPLICA_2_9_ENTROPY_SIZE);

  /** Answers every chunk at once except those whose bucket number is a multiple of 5. */
  static gateway() {
    return {
      chunkJson: async (endOffset) => {
        const bucket = (endOffset - 1n) / BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
        if (bucket % 5n === 0n) throw new Error('HTTP 404');
        return { chunk: Bytes.toBase64Url(new Uint8Array(ConsensusConstants.DATA_CHUNK_SIZE).fill(Number(bucket % 251n))) };
      },
    };
  }

  static filler({ storage, saved, onSkip = () => {} }) {
    return new ChunkFiller({
      gateway: ChunkFillerTest.gateway(), identity: MiningIdentity.fromAddress('wYnRY0GUYWkoisS45Djguy5DZ5Xt3z1bE0KDPnq66c4'),
      entropySource: ChunkFillerTest.ZERO_ENTROPY, storage, batchSize: 8,
      save: async (entries) => { saved.push(entries.length); return true; },
      onSkip,
    });
  }

  async run() {
    const partitionNumber = 20;
    const partitionUpperBound = 100n * ConsensusConstants.PARTITION_SIZE;
    const storage = new HeldStorage({ loadChunk: async () => null, residentLimit: 4 });
    const saved = [];
    let skipped = 0;
    const outcome = await ChunkFillerTest.filler({ storage, saved, onSkip: () => skipped++ }).fill({ partitionNumber, partitionUpperBound, wanted: 20, randomFraction: 0.25 });
    this.report('holds the 20 chunks wanted', outcome.held === 20 && storage.chunkCount === 20 && storage.bytesInPartition(partitionNumber) === 20 * ConsensusConstants.DATA_CHUNK_SIZE, `${outcome.held} held, ${storage.chunkCount} in storage`);
    this.report('saves in batches of 8, then the rest', saved.join() === '8,8,4', saved.join());
    this.report('skips chunks no source has', skipped > 0, `${skipped} skipped`);
    this.report('saved chunks leave memory beyond the limit', storage.residentCount <= 4, `${storage.residentCount} in memory`);
    this.report('every chunk is in the partition', [...storage.heldEndsInPartition(partitionNumber)].length === 20);

    const stopper = new AbortController();
    stopper.abort();
    const stopped = await ChunkFillerTest.filler({ storage: new HeldStorage(), saved: [] }).fill({ partitionNumber, partitionUpperBound, wanted: 20, signal: stopper.signal });
    this.report('a stopped fill holds nothing more and says it stopped', stopped.aborted && stopped.held === 0);
    this.finish();
  }
}

await new ChunkFillerTest().run();
