// src/blocks/adjustments.js — the block fields the protocol re-estimates now and then: the
// mining difficulty every 10 blocks (ar_retarget) and the storage price every 50
// (ar_pricing:recalculate_price_per_gib_minute). Rules for new blocks only: every fork
// so far is past, so the special cases at fork heights are left out.

export class DifficultyRetarget {
  /**
   * Every RETARGET_BLOCKS heights the difficulty scales so those blocks would have taken
   * TARGET_BLOCK_TIME each, unless they already took within one block time of it
   * (ar_retarget:calculate_difficulty/4). The retarget block's last_retarget is its own
   * timestamp. A localnet keeps the difficulty but still moves last_retarget.
   */
  static RETARGET_BLOCKS = 10;
  static TARGET_BLOCK_TIME = 120n;
  /** ar_block:get_max_timestamp_deviation: JOIN_CLOCK_TOLERANCE · 2 + CLOCK_DRIFT_MAX, seconds. */
  static MAX_TIMESTAMP_DEVIATION = 35n;
  static MAX_DIFF = 1n << 256n;
  /** ar_difficulty:min_difficulty from fork 2.6: switch_to_linear_diff(2). */
  static MIN_DIFF = DifficultyRetarget.MAX_DIFF - (1n << 254n);

  static isRetargetHeight(height) {
    return height % DifficultyRetarget.RETARGET_BLOCKS === 0 && height !== 0;
  }

  /**
   * ar_difficulty:scale_diff: the chance of beating the difficulty, MAX_DIFF − diff, scaled
   * by divisor/dividend, kept within [MIN_DIFF, MAX_DIFF − 1].
   */
  static scaleDiff(diff, dividend, divisor) {
    const scaled = DifficultyRetarget.MAX_DIFF - (DifficultyRetarget.MAX_DIFF - diff) * divisor / dividend;
    return scaled < DifficultyRetarget.MIN_DIFF ? DifficultyRetarget.MIN_DIFF : scaled > DifficultyRetarget.MAX_DIFF - 1n ? DifficultyRetarget.MAX_DIFF - 1n : scaled;
  }

  /** { diff, last_retarget } (strings and a number, as block JSON) of a block at `height`. */
  static fields({ height, parent, timestamp, difficultyRetargets = true }) {
    if (!DifficultyRetarget.isRetargetHeight(height)) return { diff: parent.diff, last_retarget: parent.last_retarget };
    if (!difficultyRetargets) return { diff: parent.diff, last_retarget: timestamp };
    const targetTime = BigInt(DifficultyRetarget.RETARGET_BLOCKS) * DifficultyRetarget.TARGET_BLOCK_TIME;
    const elapsed = BigInt(timestamp) - BigInt(parent.last_retarget);
    const actualTime = elapsed > DifficultyRetarget.MAX_TIMESTAMP_DEVIATION ? elapsed : DifficultyRetarget.MAX_TIMESTAMP_DEVIATION;
    const withinTolerance = actualTime < targetTime + DifficultyRetarget.TARGET_BLOCK_TIME && actualTime > targetTime - DifficultyRetarget.TARGET_BLOCK_TIME;
    const diff = withinTolerance ? BigInt(parent.diff) : DifficultyRetarget.scaleDiff(BigInt(parent.diff), targetTime, actualTime);
    return { diff: diff.toString(), last_retarget: timestamp };
  }
}

export class PriceAdjustment {
  /**
   * Every PRICE_ADJUSTMENT_FREQUENCY heights the scheduled storage price takes effect, and
   * a new one is scheduled: the network's estimated cost of storage
   * (`estimatedPricePerGibMinute`), averaged a tenth of the way in from the old scheduled
   * price and kept within half to twice it. The USD rate's scheduled value takes effect
   * likewise (it no longer changes after fork 2.6).
   */
  static PRICE_ADJUSTMENT_FREQUENCY = 50;
  /** The 2.7.2 price transition's last height (2.6.8 at 1,189,560 + 361,910 + 518,400 blocks). */
  static TRANSITION_END = 2_069_870;
  static REWARD_HISTORY_BLOCKS = 3 * 30 * 24 * 30 + 50; // ar_rewards:reward_history_length, with the consensus window
  static BLOCK_TIME_HISTORY_BLOCKS = 30 * 24 * 30;
  static POA1_DIFF_MULTIPLIER = 100n;
  static LEGACY_RECALL_RANGE_SIZE = 104_857_600n; // get_recall_range_size(0): what the estimate uses
  static DATA_CHUNK_SIZE = 262_144n;
  static PARTITION_SIZE = 3_600_000_000_000n;
  static GIB = 1n << 30n;

  static isAdjustmentHeight(height) {
    return height % PriceAdjustment.PRICE_ADJUSTMENT_FREQUENCY === 0;
  }

  /** ar_pricing:redenominate: amounts in an older denomination are 1000× smaller units. */
  static redenominate(amount, fromDenomination, toDenomination) {
    if (fromDenomination === 0) return amount;
    return amount * 1000n ** BigInt(Math.max(0, toDenomination - fromDenomination));
  }

  /**
   * ar_pricing:get_v2_price_per_gib_minute_two_difficulty: what storing a GiB for a minute
   * costs the network, estimated from its hash rate and rewards over the reward history
   * and its pace over the block-time history (the parent's, each including the parent).
   * The share of two-chunk solutions estimates how much of the weave miners hold.
   */
  static estimatedPricePerGibMinute({ parent, parentRewardHistory, parentBlockTimeHistory }) {
    let hashRateTotal = 0n;
    let rewardTotal = 0n;
    for (const entry of parentRewardHistory.entries.slice(0, PriceAdjustment.REWARD_HISTORY_BLOCKS)) {
      hashRateTotal += entry.hashRate;
      rewardTotal += PriceAdjustment.redenominate(entry.reward, entry.denomination, Number(parent.denomination));
    }
    let intervalTotal = 0n;
    let vdfIntervalTotal = 0n;
    let oneChunkCount = 0n;
    let twoChunkCount = 0n;
    for (const entry of parentBlockTimeHistory.entries.slice(0, PriceAdjustment.BLOCK_TIME_HISTORY_BLOCKS)) {
      intervalTotal += entry.blockInterval;
      vdfIntervalTotal += entry.vdfInterval;
      if (entry.chunkCount === 1n) oneChunkCount++;
      else twoChunkCount++;
    }

    const { POA1_DIFF_MULTIPLIER: poa1Mult, LEGACY_RECALL_RANGE_SIZE: rangeSize, DATA_CHUNK_SIZE: chunkSize } = PriceAdjustment;
    const maxSolutionsPerPartition = (poa1Mult + 1n) * rangeSize / (chunkSize * poa1Mult);
    let solutionsPerPartitionPerStep = maxSolutionsPerPartition;
    if (oneChunkCount !== 0n) {
      const estimated = (oneChunkCount + twoChunkCount) * rangeSize / (chunkSize * oneChunkCount * poa1Mult);
      if (estimated < solutionsPerPartitionPerStep) solutionsPerPartitionPerStep = estimated;
    }
    const atLeastOne = (value) => (value > 1n ? value : 1n);
    return solutionsPerPartitionPerStep * vdfIntervalTotal * atLeastOne(rewardTotal) * PriceAdjustment.GIB * 60n
      / (intervalTotal * atLeastOne(hashRateTotal) * PriceAdjustment.PARTITION_SIZE);
  }

  /** The price and rate fields (strings and rate pairs, as block JSON) of a block at `height`. */
  static fields({ height, parent, parentRewardHistory, parentBlockTimeHistory }) {
    const carried = {
      price_per_gib_minute: parent.price_per_gib_minute, scheduled_price_per_gib_minute: parent.scheduled_price_per_gib_minute,
      usd_to_ar_rate: parent.usd_to_ar_rate, scheduled_usd_to_ar_rate: parent.scheduled_usd_to_ar_rate,
    };
    if (!PriceAdjustment.isAdjustmentHeight(height)) return carried;
    if (height < PriceAdjustment.TRANSITION_END) throw new Error(`height ${height} adjusts prices during the 2.7.2 price transition, which is not implemented`);
    const scheduled = BigInt(parent.scheduled_price_per_gib_minute);
    const target = PriceAdjustment.estimatedPricePerGibMinute({ parent, parentRewardHistory, parentBlockTimeHistory });
    const average = (9n * scheduled + target) / 10n;
    const upper = scheduled * 2n;
    const lower = scheduled / 2n;
    const capped = average > upper ? upper : average < lower ? lower : average;
    return {
      price_per_gib_minute: scheduled.toString(), scheduled_price_per_gib_minute: capped.toString(),
      usd_to_ar_rate: parent.scheduled_usd_to_ar_rate, scheduled_usd_to_ar_rate: parent.scheduled_usd_to_ar_rate,
    };
  }
}
