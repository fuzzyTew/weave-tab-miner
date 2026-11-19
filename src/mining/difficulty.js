// src/mining/difficulty.js — Difficulty: whether a solution passes, and the odds of passing per try.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { Bytes } from '../core/bytes.js';
import { ConsensusConstants } from '../core/constants.js';

export class Difficulty {
  /**
   * Solution checks (src/ar_node_utils.erl passes_diff_check, scaled_diff;
   * src/ar_difficulty.erl sub_diff, scale_diff, poa1_diff). A hash passes when, read
   * as a big-endian integer, it is greater than the scaled difficulty.
   */
  static subDiff(diff, count) {
    const maxDiff = ConsensusConstants.MAX_DIFF;
    const reverseDiff = maxDiff - diff;
    const dividend = 2n * count * reverseDiff * maxDiff + (count - 1n) * reverseDiff * reverseDiff;
    const divisor = 2n * count * count * maxDiff * maxDiff;
    return (maxDiff * divisor - dividend * maxDiff) / divisor;
  }

  static scaleDiff(diff, scaleDividend, scaleDivisor) {
    const maxDiff = ConsensusConstants.MAX_DIFF;
    const diffInverse = ((maxDiff - diff) * scaleDivisor) / scaleDividend;
    // Approximation: the node clamps below at min_difficulty(height), a fork-era floor
    // that is far under today's difficulty. Exact would read SPORA_MIN_DIFFICULTY.
    const scaled = maxDiff - diffInverse;
    return scaled < 1n ? 1n : scaled > maxDiff - 1n ? maxDiff - 1n : scaled;
  }

  /** Threshold for one sub-chunk nonce: split across 32 sub-chunks, then eased by 1/(4 × packing difficulty). */
  static scaledForPackingDifficulty(rawDiff, packingDifficulty) {
    const subDiff = Difficulty.subDiff(rawDiff, BigInt(ConsensusConstants.SUB_CHUNK_COUNT));
    return Difficulty.scaleDiff(subDiff, 1n, BigInt(packingDifficulty) * 4n);
  }

  /** One-chunk (PoA1) solutions must beat a difficulty 100 times harder. */
  static poa1(rawDiff) {
    return Difficulty.scaleDiff(rawDiff, ConsensusConstants.POA1_DIFF_MULTIPLIER, 1n);
  }

  static passes(solutionHash, isOneChunkSolution, rawDiff, packingDifficulty = ConsensusConstants.REPLICA_2_9_PACKING_DIFFICULTY) {
    const blockDiff = isOneChunkSolution ? Difficulty.poa1(rawDiff) : rawDiff;
    return Bytes.toBigInt(solutionHash) > Difficulty.scaledForPackingDifficulty(blockDiff, packingDifficulty);
  }

  /** Chance that one random hash passes, as a float. */
  static passProbability(rawDiff, isOneChunkSolution, packingDifficulty = ConsensusConstants.REPLICA_2_9_PACKING_DIFFICULTY) {
    const blockDiff = isOneChunkSolution ? Difficulty.poa1(rawDiff) : rawDiff;
    const threshold = Difficulty.scaledForPackingDifficulty(blockDiff, packingDifficulty);
    const maxDiff = ConsensusConstants.MAX_DIFF;
    return Number(((maxDiff - threshold) * 10n ** 18n) / maxDiff) / 1e18;
  }
}
