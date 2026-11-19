// src/blocks/rewards.js — the reward history a block carries: who mined each recent block and what
// it earned. Rewards stay locked for LOCKED_REWARDS_BLOCKS blocks; each new block releases
// the oldest locked one to its miner's account (ar_rewards.erl apply_rewards).
import { Bytes } from '../core/bytes.js';

export class RewardHistory {
  /**
   * Entries newest first, as the node keeps them: { addressBytes, hashRate, reward,
   * denomination } with BigInt amounts.
   */
  static LOCKED_REWARDS_BLOCKS = 30 * 24 * 30;

  constructor(entries) {
    this.entries = entries;
  }

  /**
   * Parses GET /reward_history/{block hash} (ar_serialize reward_history_to_binary): per
   * entry, address (32) · hash rate (1-byte length, big-endian) · reward (same) ·
   * denomination (3 bytes). The node writes its newest-first list reversed, so the bytes
   * run oldest first.
   */
  static fromBinary(bytes) {
    const entries = [];
    let offset = 0;
    const readSized = () => {
      const size = bytes[offset++];
      const value = Bytes.toBigInt(bytes.subarray(offset, offset + size));
      offset += size;
      return value;
    };
    while (offset < bytes.length) {
      if (offset + 32 > bytes.length) throw new Error(`reward history ends inside an entry at byte ${offset}`);
      const addressBytes = bytes.slice(offset, offset + 32);
      offset += 32;
      const hashRate = readSized();
      const reward = readSized();
      const denomination = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
      offset += 3;
      entries.push({ addressBytes, hashRate, reward, denomination });
    }
    return new RewardHistory(entries.reverse());
  }

  /** The reward the next block releases: the oldest still locked. */
  releasedReward(lockedBlocks = RewardHistory.LOCKED_REWARDS_BLOCKS) {
    const locked = this.entries.slice(0, lockedBlocks);
    return locked[locked.length - 1];
  }
}
