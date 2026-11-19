// src/core/constants.js — Consensus constants of Arweave 2.9, as the node defines them.
// Part of the library split from the original src/mining/; see README.md "Layout".

export class ConsensusConstants {
  /**
   * Consensus values from apps/arweave/include/{ar.hrl, ar_consensus.hrl, ar_vdf.hrl}.
   */
  static DATA_CHUNK_SIZE = 262144;
  static SUB_CHUNK_COUNT = 32;
  static SUB_CHUNK_SIZE = 8192;
  static PARTITION_SIZE = 3_600_000_000_000n;
  static RECALL_RANGE_SIZE = 26_214_400;
  static REPLICA_2_9_PACKING_DIFFICULTY = 10;
  static REPLICA_2_9_ENTROPY_SIZE = 8_388_608;
  static REPLICA_2_9_ENTROPY_COUNT = 429_184n;
  static STRICT_DATA_SPLIT_THRESHOLD = 30_607_159_107_830n;
  static POA1_DIFF_MULTIPLIER = 100n;
  static MAX_DIFF = 1n << 256n;
  static VDF_CHECKPOINT_COUNT_IN_STEP = 25;
  static NONCE_LIMITER_RESET_FREQUENCY = 1200;

  static get recallRangeSize() {
    return this.RECALL_RANGE_SIZE / this.REPLICA_2_9_PACKING_DIFFICULTY;
  }
  static get noncesPerRecallRange() {
    return this.recallRangeSize / this.SUB_CHUNK_SIZE;
  }
  static get entropySectorSize() {
    return this.REPLICA_2_9_ENTROPY_COUNT * BigInt(this.SUB_CHUNK_SIZE);
  }
  static get subChunksPerEntropy() {
    return this.REPLICA_2_9_ENTROPY_SIZE / this.SUB_CHUNK_SIZE;
  }
}
