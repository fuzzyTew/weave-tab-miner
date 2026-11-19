// src/mining/mining-math.js — The per-step hashes: H0, the recall ranges, H1 and H2.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { Bytes } from '../core/bytes.js';
import { ConsensusConstants } from '../core/constants.js';
import { Sha256 } from '../core/sha256.js';

export class StubH0Hasher {
  /**
   * STUB — not consensus-compatible; for browsers that cannot allocate the 512 MiB RandomX
   * cache. Real H0 is RandomxH0Hasher (src/mining/randomx.js). Hashes the same preimage with
   * SHA-256 so everything after H0 still runs on real rules.
   */
  isStub = true;

  async hash(preimage) {
    return Sha256.hash(preimage);
  }
}

export class MiningMath {
  /**
   * The per-step mining computations (src/ar_block.erl compute_h0, compute_h1,
   * compute_h2, get_recall_range, get_recall_byte).
   */
  /** H0's input. Erlang's Seed:32/binary keeps the first 32 bytes of the 48-byte seed. */
  static h0Preimage(vdfOutput, partitionNumber, seed, addressBytes, packingDifficulty) {
    return Bytes.concat(vdfOutput, Bytes.fromBigInt(BigInt(partitionNumber), 32), seed.subarray(0, 32), addressBytes, new Uint8Array([packingDifficulty]));
  }

  /** Start bytes of the two recall ranges: one inside your partition, one anywhere. */
  static recallRangeStarts(h0, partitionNumber, partitionUpperBound) {
    const partitionSize = ConsensusConstants.PARTITION_SIZE;
    const offsetInPartition = Bytes.toBigInt(h0.subarray(0, 8));
    const range1Window = partitionSize < partitionUpperBound ? partitionSize : partitionUpperBound;
    const range1Start = BigInt(partitionNumber) * partitionSize + (offsetInPartition % range1Window);
    const range2Start = Bytes.toBigInt(h0) % partitionUpperBound;
    return [range1Start, range2Start];
  }

  /** The weave byte a nonce points at, and which of that chunk's 32 sub-chunks it uses. */
  static recallByteForNonce(rangeStart, nonce) {
    const chunkNumber = BigInt(Math.floor(nonce / ConsensusConstants.SUB_CHUNK_COUNT));
    return [rangeStart + chunkNumber * BigInt(ConsensusConstants.DATA_CHUNK_SIZE), nonce % ConsensusConstants.SUB_CHUNK_COUNT];
  }

  static h1(h0, nonce, subChunk1) {
    const preimage = Sha256.hash(h0, Bytes.fromBigInt(BigInt(nonce), 8), subChunk1);
    return { hash: Sha256.hash(h0, preimage), preimage };
  }

  /** Assumption: compute_h2 receives H1's solution hash (not its preimage). */
  static h2(h1Hash, subChunk2, h0) {
    const preimage = Sha256.hash(h1Hash, subChunk2);
    return { hash: Sha256.hash(h0, preimage), preimage };
  }
}
