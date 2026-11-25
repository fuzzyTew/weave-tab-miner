// src/blocks/network-rules.js — where networks running the same node code differ: a localnet
// (Arweave's private test chain) skips the difficulty and the recall range, so blocks there
// are cheap to make.

export class NetworkRules {
  /**
   * `difficultyRetargets`: the difficulty is re-estimated every 10 blocks (a localnet
   * keeps it fixed). `difficultyChecked`: a block's solution must beat it (a localnet
   * takes any). `recallRangeChecked`: a block's recall chunks must lie in the ranges its
   * H0 picks (a localnet takes any chunk the weave holds).
   */
  constructor({ name, difficultyRetargets, difficultyChecked, recallRangeChecked }) {
    Object.assign(this, { name, difficultyRetargets, difficultyChecked, recallRangeChecked });
  }

  static MAINNET = new NetworkRules({ name: 'mainnet', difficultyRetargets: true, difficultyChecked: true, recallRangeChecked: true });
  static LOCALNET = new NetworkRules({ name: 'localnet', difficultyRetargets: false, difficultyChecked: false, recallRangeChecked: false });

  /**
   * How far a Miner may bend the mainnet's rules and still make blocks this network takes,
   * in the Miner's testMode terms: range 1 aimed at held data where ranges are not checked,
   * and every hash passing where the difficulty is not.
   */
  minerAllowance() {
    return {
      aimRange1AtHeldData: !this.recallRangeChecked,
      difficultyEase: this.difficultyChecked ? 1 : Number.POSITIVE_INFINITY,
    };
  }
}
