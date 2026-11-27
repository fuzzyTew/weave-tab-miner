// src/mining/odds.js — How long a solution takes on average, and why.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { ConsensusConstants } from '../core/constants.js';
import { PrettyNumber } from '../core/pretty-number.js';
import { Difficulty } from './difficulty.js';

export class SolutionOdds {
  /**
   * Expected waiting time for a real solution with the storage held, from the same rules
   * the miner applies. Each held nonce gives an H1 try (100 times harder), plus an H2 try
   * when its range-2 location is also held.
   */
  static NETWORK_STEPS_PER_SECOND = 1; // the VDF difficulty is retargeted toward one step a second

  static rates({ storage, partitionNumber, session }) {
    const partitionWindow = Number(session.partitionUpperBound < ConsensusConstants.PARTITION_SIZE ? session.partitionUpperBound : ConsensusConstants.PARTITION_SIZE);
    return {
      heldFractionOfPartition: storage.bytesInPartition(partitionNumber) / partitionWindow,
      heldFractionOfWeave: storage.byteCount / Number(session.partitionUpperBound),
      h1Probability: Difficulty.passProbability(session.networkDiff, true),
      h2Probability: Difficulty.passProbability(session.networkDiff, false),
    };
  }

  static solutionsPerStep({ heldFractionOfPartition, heldFractionOfWeave, h1Probability, h2Probability }) {
    return ConsensusConstants.noncesPerRecallRange * heldFractionOfPartition * (h1Probability + heldFractionOfWeave * h2Probability);
  }

  static expectedSecondsPerSolution({ storage, partitionNumber, session, stepsPerSecond = SolutionOdds.NETWORK_STEPS_PER_SECOND }) {
    const perStep = SolutionOdds.solutionsPerStep(SolutionOdds.rates({ storage, partitionNumber, session }));
    return perStep > 0 ? 1 / (perStep * stepsPerSecond) : Infinity;
  }

  /**
   * Why the wait is as long as it is, as factors that multiply: the wait of a miner that
   * holds the whole partition and the whole weave at the network's pace, times one factor
   * per shortfall. Each factor is how many times shorter the wait would be if only that
   * shortfall were removed; all of them together give the wait itself.
   *
   * `quotaBytes` (optional) is how much this browser lets the tab store; with it, the
   * storage factor also says how far the tab itself could bring it down.
   */
  static waitBreakdown({ storage, partitionNumber, session, stepsPerSecond = SolutionOdds.NETWORK_STEPS_PER_SECOND, quotaBytes = null }) {
    const rates = SolutionOdds.rates({ storage, partitionNumber, session });
    const fullSpeedPerStep = SolutionOdds.solutionsPerStep({ ...rates, heldFractionOfPartition: 1, heldFractionOfWeave: 1 });
    const fullSpeedSeconds = 1 / (fullSpeedPerStep * SolutionOdds.NETWORK_STEPS_PER_SECOND);
    const partitionWindow = rates.heldFractionOfPartition > 0 ? storage.bytesInPartition(partitionNumber) / rates.heldFractionOfPartition : Number(ConsensusConstants.PARTITION_SIZE);
    const factors = [];

    let storageNote = `holding ${(rates.heldFractionOfPartition * 100).toPrecision(2)}% of partition ${partitionNumber}`;
    if (quotaBytes) {
      const mostHeld = Math.min(quotaBytes, partitionWindow);
      storageNote += `; this browser allows about ${PrettyNumber.bytes(quotaBytes)}, so the most this tab could reach is ×${PrettyNumber.factor(partitionWindow / mostHeld)}`;
    }
    factors.push({ name: 'storage', multiplier: rates.heldFractionOfPartition > 0 ? 1 / rates.heldFractionOfPartition : Infinity, explanation: storageNote });

    const withCoverage = rates.h1Probability + rates.heldFractionOfWeave * rates.h2Probability;
    factors.push({ name: 'coverage', multiplier: (rates.h1Probability + rates.h2Probability) / withCoverage,
      explanation: `two-chunk tries need range 2 held too, which happens ${(rates.heldFractionOfWeave * 100).toPrecision(2)}% of the time; they pass 100× more often than one-chunk tries` });

    factors.push({ name: 'VDF pace', multiplier: SolutionOdds.NETWORK_STEPS_PER_SECOND / stepsPerSecond,
      explanation: `${stepsPerSecond >= 1 ? 'keeping up with' : `${(1 / stepsPerSecond).toFixed(1)} s per step against`} the network's one step a second` });

    const seconds = factors.reduce((product, factor) => product * factor.multiplier, fullSpeedSeconds);
    return { fullSpeedSeconds, factors, seconds };
  }

  /**
   * The chance that one step's range 1 touches any held chunk, so that at least one
   * one-chunk try happens. Range 1 starts uniformly in the partition and covers
   * RECALL_RANGE bytes; it touches a held chunk ending at e when it starts within
   * (e - chunk - range, e). The union of those windows over all held chunks, divided by
   * the partition, is the chance. Held chunks next to each other share windows, so this
   * depends on where the chunks are, not only how many.
   */
  static heldRangeHitChance({ storage, partitionNumber, session }) {
    // The walk below sorts every held offset: seconds at millions of chunks. So the answer
    // is kept per storage and reused until chunks are added, and with many chunks held, for
    // at least HIT_CHANCE_REUSE_MS after that too (it moves slowly once much is held).
    // Updating the covered length as each chunk arrives would make it O(1) per chunk.
    const cached = SolutionOdds.hitChanceCache.get(storage);
    const window = String(session.partitionUpperBound);
    const reusable = cached && cached.partitionNumber === partitionNumber && cached.window === window
      && (cached.changeCount === storage.changeCount
        || (storage.chunkCount > SolutionOdds.HIT_CHANCE_MANY_CHUNKS && performance.now() - cached.at < SolutionOdds.HIT_CHANCE_REUSE_MS));
    if (reusable) return cached.chance;
    const chance = SolutionOdds.walkHeldRangeHitChance({ storage, partitionNumber, session });
    SolutionOdds.hitChanceCache.set(storage, { partitionNumber, window, changeCount: storage.changeCount, at: performance.now(), chance });
    return chance;
  }

  static hitChanceCache = new WeakMap();
  static HIT_CHANCE_MANY_CHUNKS = 100_000;
  static HIT_CHANCE_REUSE_MS = 60_000;

  /** heldRangeHitChance's walk over every held offset, uncached. */
  static walkHeldRangeHitChance({ storage, partitionNumber, session }) {
    const partitionStart = BigInt(partitionNumber) * ConsensusConstants.PARTITION_SIZE;
    const window = Number(session.partitionUpperBound < ConsensusConstants.PARTITION_SIZE ? session.partitionUpperBound : ConsensusConstants.PARTITION_SIZE);
    const reach = ConsensusConstants.DATA_CHUNK_SIZE + ConsensusConstants.recallRangeSize;
    const ends = [...storage.heldEndsInPartition(partitionNumber)].map((end) => Number(end - partitionStart));
    let covered = 0;
    let runStart = null;
    let runEnd = null;
    for (const end of ends) {
      const start = Math.max(0, end - reach);
      if (runEnd !== null && start <= runEnd) {
        runEnd = Math.max(runEnd, end);
      } else {
        if (runEnd !== null) covered += runEnd - runStart;
        runStart = start;
        runEnd = end;
      }
    }
    if (runEnd !== null) covered += runEnd - runStart;
    return Math.min(1, covered / window);
  }

  /**
   * The same estimate for a group pooling `storedBytes` of distinct data under one
   * address, packed in whole partitions (the best case for the squared bonus).
   */
  static forPooledStorage({ storedBytes, session, stepsPerSecond = SolutionOdds.NETWORK_STEPS_PER_SECOND }) {
    const partitionsCovered = storedBytes / Number(ConsensusConstants.PARTITION_SIZE);
    const weaveFraction = Math.min(1, storedBytes / Number(session.partitionUpperBound));
    const h1Probability = Difficulty.passProbability(session.networkDiff, true);
    const h2Probability = Difficulty.passProbability(session.networkDiff, false);
    const solutionsPerSecond = partitionsCovered * ConsensusConstants.noncesPerRecallRange * (h1Probability + weaveFraction * h2Probability) * stepsPerSecond;
    const winstonPerSecond = solutionsPerSecond * Number(session.blockRewardWinston);
    return { secondsPerBlock: solutionsPerSecond > 0 ? 1 / solutionsPerSecond : Infinity, arPerDay: (winstonPerSecond * 86_400) / 1e12 };
  }

  /**
   * Average days until a pool member's earnings, after the pool's fee, reach the pool's
   * payout threshold. With PPLNS (pay per last N shares) this is the long-run average; the
   * pool pays only when it finds a block, so real payouts come in lumps around it.
   */
  static daysToPayout({ memberArPerDay, feeFraction, thresholdAr }) {
    const keptPerDay = memberArPerDay * (1 - feeFraction);
    return keptPerDay > 0 ? thresholdAr / keptPerDay : Infinity;
  }
}
