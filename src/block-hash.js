// src/block-hash.js — the hash a miner signs and the block's id (ar_block.erl
// generate_signed_hash and indep_hash, from fork 2.9), built from block JSON as nodes serve
// it. Step 4 of docs/TODO.md "Turn a solution into a block".
import { Bytes, Sha256 } from './miner.js';

export class SegmentWriter {
  /**
   * Appends fields the way ar_serialize does. "Sized" fields are prefixed by their length
   * in a fixed number of bits (8, 16 or 24); integers are written big-endian with no
   * leading zeros; a missing value is written as length zero.
   */
  constructor() {
    this.parts = [];
  }

  static unsigned(value) {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    return Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
  }

  static fixedInteger(value, byteCount) {
    const bytes = new Uint8Array(byteCount);
    let remaining = BigInt(value);
    for (let index = byteCount - 1; index >= 0; index--) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    if (remaining) throw new Error(`${value} does not fit in ${byteCount} bytes`);
    return bytes;
  }

  raw(bytes) {
    this.parts.push(bytes);
    return this;
  }

  fixed(value, byteCount) {
    return this.raw(SegmentWriter.fixedInteger(value, byteCount));
  }

  /** encode_bin(Bin, SizeBits); null or undefined writes a zero length. */
  sizedBytes(bytes, sizeBits) {
    if (bytes === null || bytes === undefined) return this.fixed(0, sizeBits / 8);
    return this.fixed(bytes.length, sizeBits / 8).raw(bytes);
  }

  /** encode_int(N, SizeBits); null or undefined writes a zero length. */
  sizedInteger(value, sizeBits) {
    if (value === null || value === undefined) return this.fixed(0, sizeBits / 8);
    return this.sizedBytes(SegmentWriter.unsigned(value), sizeBits);
  }

  /** encode_bin_list: the count, then each element sized — in reverse order, as the node's accumulator leaves them. */
  sizedList(list, countBits, elementBits) {
    this.fixed(list.length, countBits / 8);
    for (let index = list.length - 1; index >= 0; index--) this.sizedBytes(list[index], elementBits);
    return this;
  }

  bytes() {
    const joined = new Uint8Array(this.parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of this.parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  }
}

export class BlockHash {
  static decode(text) {
    return text === undefined || text === null ? null : Bytes.fromBase64Url(text);
  }

  /** A block's empty double-signing proof (no proof) is one zero byte; proofs are not handled yet. */
  static doubleSigningProofBytes(proof) {
    if (!proof || Object.keys(proof).length === 0) return new Uint8Array([0]);
    throw new Error('blocks carrying a double-signing proof are not handled yet');
  }

  /** The bytes whose SHA-256 the miner signs (generate_signed_hash), for heights from 2.9 on. */
  static signedPreimage(block) {
    const decode = BlockHash.decode;
    const limiter = block.nonce_limiter_info;
    const [rateDividend, rateDivisor] = block.usd_to_ar_rate;
    const [scheduledDividend, scheduledDivisor] = block.scheduled_usd_to_ar_rate;
    // The JSON nonce is the integer's bytes; the node re-encodes the integer minimally.
    const nonce = SegmentWriter.unsigned(Bytes.toBigInt(decode(block.nonce)));
    const writer = new SegmentWriter()
      .sizedBytes(decode(block.previous_block), 8).sizedInteger(block.timestamp, 8)
      .sizedBytes(nonce, 16).sizedInteger(block.height, 8)
      .sizedInteger(block.diff, 16).sizedInteger(block.cumulative_diff, 16)
      .sizedInteger(block.last_retarget, 8).sizedBytes(decode(block.hash), 8)
      .sizedInteger(block.block_size, 16).sizedInteger(block.weave_size, 16)
      .sizedBytes(decode(block.reward_addr), 8).sizedBytes(decode(block.tx_root), 8)
      .sizedBytes(decode(block.wallet_list), 8)
      .sizedBytes(decode(block.hash_list_merkle), 8).sizedInteger(block.reward_pool, 8)
      .sizedInteger(block.packing_2_5_threshold, 8)
      .sizedInteger(block.strict_data_split_threshold, 8)
      .sizedInteger(rateDividend, 8).sizedInteger(rateDivisor, 8)
      .sizedInteger(scheduledDividend, 8).sizedInteger(scheduledDivisor, 8)
      .sizedList(block.tags.map(decode), 16, 16)
      .sizedList(block.txs.map(decode), 16, 8)
      .sizedInteger(block.reward, 8)
      .sizedInteger(block.recall_byte, 16).sizedBytes(decode(block.hash_preimage), 8)
      .sizedInteger(block.recall_byte2, 16).sizedBytes(decode(block.reward_key), 16)
      .sizedInteger(block.partition_number, 8)
      .raw(decode(limiter.output)).fixed(limiter.global_step_number, 8)
      .raw(decode(limiter.seed)).raw(decode(limiter.next_seed))
      .fixed(limiter.zone_upper_bound, 32).fixed(limiter.next_zone_upper_bound, 32)
      .sizedBytes(decode(limiter.prev_output), 8)
      .fixed(limiter.checkpoints.length, 2).raw(Bytes.concat(...limiter.checkpoints.map(decode)))
      .fixed(limiter.last_step_checkpoints.length, 2).raw(Bytes.concat(...limiter.last_step_checkpoints.map(decode)))
      .sizedBytes(decode(block.previous_solution_hash), 8)
      .sizedInteger(block.price_per_gib_minute, 8)
      .sizedInteger(block.scheduled_price_per_gib_minute, 8)
      .raw(decode(block.reward_history_hash)).sizedInteger(block.debt_supply, 8)
      .fixed(block.kryder_plus_rate_multiplier, 3).fixed(block.kryder_plus_rate_multiplier_latch, 1)
      .fixed(block.denomination, 3)
      .sizedInteger(block.redenomination_height, 8)
      .raw(BlockHash.doubleSigningProofBytes(block.double_signing_proof))
      .sizedInteger(block.previous_cumulative_diff, 16)
      .sizedInteger(block.merkle_rebase_support_threshold, 16)
      .sizedBytes(decode(block.poa.data_path), 24).sizedBytes(decode(block.poa.tx_path), 24)
      .sizedBytes(decode(block.poa2?.data_path ?? ''), 24).sizedBytes(decode(block.poa2?.tx_path ?? ''), 24)
      .raw(decode(block.chunk_hash)).sizedBytes(decode(block.chunk2_hash), 8)
      .raw(decode(block.block_time_history_hash))
      .sizedInteger(limiter.vdf_difficulty, 8).sizedInteger(limiter.next_vdf_difficulty, 8)
      .fixed(block.packing_difficulty, 1)
      .sizedBytes(decode(block.unpacked_chunk_hash), 8).sizedBytes(decode(block.unpacked_chunk2_hash), 8)
      .fixed(block.replica_format ?? 0, 1);
    return writer.bytes();
  }

  static signedHash(block) {
    return Sha256.hash(BlockHash.signedPreimage(block));
  }

  /**
   * What the key actually signs (get_block_signature_preimage, from 2.9): 32 zero bytes,
   * then the cumulative difficulty and the parent's (sized by 16 bits), the previous
   * solution hash, and the signed hash.
   */
  static signaturePreimage(block) {
    return new SegmentWriter().raw(new Uint8Array(32))
      .sizedInteger(block.cumulative_diff, 16).sizedInteger(block.previous_cumulative_diff, 16)
      .raw(BlockHash.decode(block.previous_solution_hash)).raw(BlockHash.signedHash(block)).bytes();
  }

  /** The block's id: SHA-384 of the signed hash followed by the signature (indep_hash2). */
  static async indepHash(block) {
    const joined = Bytes.concat(BlockHash.signedHash(block), BlockHash.decode(block.signature));
    return new Uint8Array(await crypto.subtle.digest('SHA-384', joined));
  }
}
