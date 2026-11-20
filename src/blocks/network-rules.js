// src/blocks/network-rules.js — where networks running the same node code differ: a localnet
// (Arweave's private test chain) skips the difficulty, so blocks there are cheap to make.

export class NetworkRules {
  /**
   * `difficultyRetargets`: the difficulty is re-estimated every 10 blocks (a localnet
   * keeps it fixed). `difficultyChecked`: a block's solution must beat it (a localnet
   * takes any).
   */
  constructor({ name, difficultyRetargets, difficultyChecked }) {
    Object.assign(this, { name, difficultyRetargets, difficultyChecked });
  }

  static MAINNET = new NetworkRules({ name: 'mainnet', difficultyRetargets: true, difficultyChecked: true });
  static LOCALNET = new NetworkRules({ name: 'localnet', difficultyRetargets: false, difficultyChecked: false });
}
