// src/block-history.js — the three hashes a block carries over its predecessors: the reward
// history hash, the block-time history hash, and the block-index hash
// (`hash_list_merkle`). Step 2 of docs/TODO.md "Turn a solution into a block".
import { Bytes, Sha256 } from './miner.js';
import { DeepHash } from './transaction.js';

export class SerializedInt {
  /** ar_serialize:encode_int(N, 8): a one-byte length, then N big-endian with no leading zeros. */
  static encode(value) {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const bytes = Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
    return Bytes.concat(new Uint8Array([bytes.length]), bytes);
  }
}

export class BlockTimeHistory {
  /**
   * Recent blocks' { blockInterval, vdfInterval, chunkCount }, newest first
   * (ar_block_time_history.erl). The hash covers the latest HISTORY_BLOCKS of them.
   */
  static HISTORY_BLOCKS = 30 * 24 * 30;

  constructor(entries) {
    this.entries = entries;
  }

  /** GET /block_time_history/{hash}: three encode_int values per entry, oldest first. */
  static fromBinary(bytes) {
    const entries = [];
    let offset = 0;
    const read = () => {
      const size = bytes[offset++];
      const value = Bytes.toBigInt(bytes.subarray(offset, offset + size));
      offset += size;
      return value;
    };
    while (offset < bytes.length) entries.push({ blockInterval: read(), vdfInterval: read(), chunkCount: read() });
    return new BlockTimeHistory(entries.reverse());
  }

  /** The entry a block adds over its parent (get_history_element). */
  static elementFor(block, parent) {
    return {
      blockInterval: BigInt(Math.max(1, Number(block.timestamp) - Number(parent.timestamp))),
      vdfInterval: BigInt(block.nonce_limiter_info.global_step_number) - BigInt(parent.nonce_limiter_info.global_step_number),
      chunkCount: block.recall_byte2 === undefined ? 1n : 2n,
    };
  }

  withNewest(entry) {
    return new BlockTimeHistory([entry, ...this.entries]);
  }

  /** SHA-256 over the latest entries oldest first, then their count (ar_block_time_history:hash). */
  hash() {
    const latest = this.entries.slice(0, BlockTimeHistory.HISTORY_BLOCKS);
    const parts = [];
    for (let index = latest.length - 1; index >= 0; index--) {
      const { blockInterval, vdfInterval, chunkCount } = latest[index];
      parts.push(SerializedInt.encode(blockInterval), SerializedInt.encode(vdfInterval), SerializedInt.encode(chunkCount));
    }
    parts.push(SerializedInt.encode(latest.length));
    // Tens of thousands of parts: joined by hand, since spreading them as arguments overflows.
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return Sha256.hash(joined);
  }
}

export class BlockHistoryHashes {
  /** The protocol's largest difficulty, 2^256 (?MAX_DIFF). */
  static MAX_DIFF = 1n << 256n;

  /** ar_difficulty:get_hash_rate_fixed_ratio after 2.8: MAX_DIFF div (MAX_DIFF - diff). */
  static hashRate(diff) {
    return BlockHistoryHashes.MAX_DIFF / (BlockHistoryHashes.MAX_DIFF - BigInt(diff));
  }

  /**
   * After 2.8 the reward history hash chains: SHA-256 of this block's own entry's hash
   * followed by the parent's hash (ar_rewards:reward_history_hash).
   */
  static rewardHistoryHash(block, parentRewardHistoryHash) {
    const element = Sha256.hash(
      Bytes.fromBase64Url(block.reward_addr), SerializedInt.encode(BlockHistoryHashes.hashRate(block.diff)),
      SerializedInt.encode(block.reward), new Uint8Array([0, 0, Number(block.denomination)]));
    return Sha256.hash(element, parentRewardHistoryHash);
  }

  /**
   * The block index hash: the parent's, extended by the parent's own entry
   * (ar_unbalanced_merkle:root with hash_block_index_entry), with SHA-384 throughout.
   */
  static async hashListMerkle(parent) {
    const entry = await DeepHash.of([
      Bytes.fromBase64Url(parent.indep_hash), new TextEncoder().encode(String(parent.weave_size)), Bytes.fromBase64Url(parent.tx_root),
    ]);
    return DeepHash.sha384(Bytes.concat(Bytes.fromBase64Url(parent.hash_list_merkle), entry));
  }
}
