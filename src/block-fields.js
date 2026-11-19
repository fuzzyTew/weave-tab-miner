// src/block-fields.js — the plain fields of the next block, computed from its parent: height,
// links to the parent, cumulative difficulty, the reward, and the pools and prices carried
// forward. Step 3 of docs/TODO.md "Building blocks". Empty blocks only (no transactions).
import { BlockTimeHistory } from './block-history.js';

export class Inflation {
  /**
   * The new tokens a block mints (ar_inflation.erl calculate_base, from fork 2.5): a
   * halving every ~4 years written as e^(height·ln2 / blocks per year), with e^x computed
   * as a fraction to PRECISION terms of its series — exact integers, no floating point.
   */
  static LN2 = [6931471805599453n, 10000000000000000n];
  static PRECISION = 24;
  static GENESIS_TOKENS = 55000000n;
  static WINSTON_PER_AR = 1000000000000n;
  static TARGET_BLOCK_TIME = 120;

  static blocksPerYear() {
    return BigInt(Math.floor((60 * 60 * 24 * 365) / Inflation.TARGET_BLOCK_TIME));
  }

  /** ar_fraction:natural_exponent: e^(dividend/divisor) as [dividend, divisor]. */
  static naturalExponent([dividend, divisor], precision) {
    if (dividend === 0n) return [1n, 1n];
    let total = 0n;
    let k = 0n;
    let multiplier = 1n;
    for (let power = precision; power >= 0; power--) {
      total += dividend ** BigInt(power) * divisor ** k * multiplier;
      k++;
      multiplier *= BigInt(power);
    }
    let factorial = 1n;
    for (let index = 2n; index <= BigInt(precision); index++) factorial *= index;
    return [total, divisor ** BigInt(precision) * factorial];
  }

  static winston(height) {
    const [ln2Dividend, ln2Divisor] = Inflation.LN2;
    const blocksPerYear = Inflation.blocksPerYear();
    const [exponentDividend, exponentDivisor] = Inflation.naturalExponent([BigInt(height) * ln2Dividend, blocksPerYear * ln2Divisor], Inflation.PRECISION);
    return (Inflation.GENESIS_TOKENS * Inflation.WINSTON_PER_AR * exponentDivisor * 2n * ln2Dividend)
      / (10n * blocksPerYear * ln2Divisor * exponentDividend);
  }
}

export class NextBlockFields {
  /** The protocol's largest difficulty, 2^256 (?MAX_DIFF). */
  static MAX_DIFF = 1n << 256n;
  static N_REPLICATIONS = 20n; // from fork 2.6
  static GIB = 1n << 30n;
  static PRICE_ADJUSTMENT_FREQUENCY = 50;
  static RESET_KRYDER_PLUS_LATCH_THRESHOLD = 10_000_000_000_000_000n; // 10,000 AR (ar_pricing.hrl)

  /**
   * The average block interval the reward is priced over (compute_block_interval): the
   * mean of the parent's latest HISTORY_BLOCKS intervals, rounded down.
   */
  static blockInterval(parentBlockTimeHistory) {
    const latest = parentBlockTimeHistory.entries.slice(0, BlockTimeHistory.HISTORY_BLOCKS);
    if (latest.length < BlockTimeHistory.HISTORY_BLOCKS) return 120n;
    return latest.reduce((total, entry) => total + entry.blockInterval, 0n) / BigInt(BlockTimeHistory.HISTORY_BLOCKS);
  }

  /**
   * The miner's reward and the endowment pool, debt supply and Kryder+ multiplier after
   * it (ar_pricing:get_miner_reward_endowment_pool_debt_supply), with no transaction
   * fees. The reward is the inflation, topped up from the endowment pool when that falls
   * short of what storing the weave for this interval is expected to cost.
   */
  static reward({ height, weaveSize, pricePerGibMinute, blockInterval, endowmentPool, debtSupply, kryderLatch, kryderMultiplier }) {
    const base = Inflation.winston(height);
    const expected = NextBlockFields.N_REPLICATIONS * weaveSize * pricePerGibMinute * blockInterval / (60n * NextBlockFields.GIB);
    if (base >= expected) return { reward: base, endowmentPool, debtSupply, kryderLatch, kryderMultiplier };
    const take = expected - base;
    const poolShort = take > endowmentPool;
    const endowmentPoolAfter = poolShort ? 0n : endowmentPool - take;
    const debtSupplyAfter = poolShort ? debtSupply + take - endowmentPool : debtSupply;
    let latch = kryderLatch;
    let multiplier = kryderMultiplier;
    if (poolShort && kryderLatch === 0n) {
      latch = 1n;
      multiplier = kryderMultiplier * 2n;
    } else if (!poolShort && kryderLatch === 1n) {
      latch = endowmentPoolAfter > NextBlockFields.RESET_KRYDER_PLUS_LATCH_THRESHOLD ? 0n : 1n;
    }
    return { reward: base + take, endowmentPool: endowmentPoolAfter, debtSupply: debtSupplyAfter, kryderLatch: latch, kryderMultiplier: multiplier };
  }

  /**
   * Fields of an empty block on `parent` (block JSON as nodes serve it), as strings and
   * numbers in the same JSON form. `timestamp` is the miner's clock, in seconds.
   *
   * STUBS, which throw rather than guess: a price adjustment height (every 50 blocks,
   * ar_pricing:recalculate_price_per_gib_minute), a difficulty retarget
   * (`isRetargetHeight`, supplied by the caller), and redenomination.
   */
  static compute({ parent, parentBlockTimeHistory, timestamp, isRetargetHeight = () => false }) {
    const height = parent.height + 1;
    if (height % NextBlockFields.PRICE_ADJUSTMENT_FREQUENCY === 0) throw new Error(`height ${height} adjusts prices, which is not implemented yet`);
    if (isRetargetHeight(height)) throw new Error(`height ${height} retargets difficulty, which is not implemented yet`);
    if (Number(parent.redenomination_height) > parent.height) throw new Error('a scheduled redenomination is not implemented yet');

    const diff = BigInt(parent.diff);
    const rewardFields = NextBlockFields.reward({
      height,
      weaveSize: BigInt(parent.weave_size),
      pricePerGibMinute: BigInt(parent.price_per_gib_minute),
      blockInterval: NextBlockFields.blockInterval(parentBlockTimeHistory),
      endowmentPool: BigInt(parent.reward_pool),
      debtSupply: BigInt(parent.debt_supply),
      kryderLatch: BigInt(parent.kryder_plus_rate_multiplier_latch),
      kryderMultiplier: BigInt(parent.kryder_plus_rate_multiplier),
    });
    return {
      height,
      previous_block: parent.indep_hash,
      previous_solution_hash: parent.hash,
      timestamp,
      last_retarget: parent.last_retarget,
      diff: parent.diff,
      previous_cumulative_diff: parent.cumulative_diff,
      cumulative_diff: (BigInt(parent.cumulative_diff) + NextBlockFields.MAX_DIFF / (NextBlockFields.MAX_DIFF - diff)).toString(),
      reward: rewardFields.reward.toString(),
      reward_pool: rewardFields.endowmentPool.toString(),
      debt_supply: rewardFields.debtSupply.toString(),
      kryder_plus_rate_multiplier_latch: rewardFields.kryderLatch.toString(),
      kryder_plus_rate_multiplier: rewardFields.kryderMultiplier.toString(),
      denomination: parent.denomination,
      redenomination_height: parent.redenomination_height,
      price_per_gib_minute: parent.price_per_gib_minute,
      scheduled_price_per_gib_minute: parent.scheduled_price_per_gib_minute,
      usd_to_ar_rate: parent.usd_to_ar_rate,
      scheduled_usd_to_ar_rate: parent.scheduled_usd_to_ar_rate,
      weave_size: parent.weave_size,
      block_size: '0',
      tx_root: '',
      txs: [],
      merkle_rebase_support_threshold: parent.merkle_rebase_support_threshold,
    };
  }
}
