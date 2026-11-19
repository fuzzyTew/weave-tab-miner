// src/blocks/binary.js — a block in the binary form nodes accept from peers (POST /block2;
// ar_serialize.erl block_to_binary, with the fields added at forks 2.6 to 2.9), from block
// JSON as nodes serve it. Part of step 6 of docs/TODO.md "Turn a solution into a block".
import { Bytes } from '../core/bytes.js';
import { BlockHash, SegmentWriter } from './hash.js';

export class BlockBinary {
  static decode(text) {
    return BlockHash.decode(text);
  }

  /** encode_transactions: a 16-bit count, then each id with a 24-bit size, last first. */
  static transactions(writer, ids) {
    writer.fixed(ids.length, 2);
    for (let index = ids.length - 1; index >= 0; index--) writer.fixed(32, 3).raw(BlockBinary.decode(ids[index]));
  }

  static encode(block) {
    const decode = BlockBinary.decode;
    const limiter = block.nonce_limiter_info;
    const poa = block.poa;
    const poa2 = block.poa2 ?? {};
    const [rateDividend, rateDivisor] = block.usd_to_ar_rate;
    const [scheduledDividend, scheduledDivisor] = block.scheduled_usd_to_ar_rate;
    const nonce = SegmentWriter.unsigned(Bytes.toBigInt(decode(block.nonce)));
    const optionalBytes = (text) => (text ? decode(text) : new Uint8Array(0));
    const writer = new SegmentWriter()
      .raw(decode(block.indep_hash)).sizedBytes(decode(block.previous_block), 8).sizedInteger(block.timestamp, 8)
      .sizedBytes(nonce, 16).sizedInteger(block.height, 8)
      .sizedInteger(block.diff, 16).sizedInteger(block.cumulative_diff, 16)
      .sizedInteger(block.last_retarget, 8).sizedBytes(decode(block.hash), 8)
      .sizedInteger(block.block_size, 16).sizedInteger(block.weave_size, 16)
      .sizedBytes(decode(block.reward_addr), 8).sizedBytes(decode(block.tx_root), 8)
      .sizedBytes(decode(block.wallet_list), 8).sizedBytes(decode(block.hash_list_merkle), 8)
      .sizedInteger(block.reward_pool, 8).sizedInteger(block.packing_2_5_threshold, 8)
      .sizedInteger(block.strict_data_split_threshold, 8)
      .sizedInteger(rateDividend, 8).sizedInteger(rateDivisor, 8)
      .sizedInteger(scheduledDividend, 8).sizedInteger(scheduledDivisor, 8)
      .sizedInteger(poa.option, 8)
      .sizedBytes(decode(poa.chunk), 24).sizedBytes(decode(poa.tx_path), 24).sizedBytes(decode(poa.data_path), 24)
      .sizedList(block.tags.map(decode), 16, 16);
    BlockBinary.transactions(writer, block.txs);

    // From 2.6.
    writer.sizedBytes(decode(block.hash_preimage), 8).sizedInteger(block.recall_byte, 16)
      .sizedInteger(block.reward, 8).sizedBytes(decode(block.signature), 16)
      .sizedInteger(block.recall_byte2, 16)
      .sizedBytes(decode(block.previous_solution_hash), 8).fixed(block.partition_number, 32)
      .raw(decode(limiter.output)).fixed(limiter.global_step_number, 8)
      .raw(decode(limiter.seed)).raw(decode(limiter.next_seed))
      .sizedBytes(decode(limiter.prev_output), 8)
      .fixed(limiter.zone_upper_bound, 32).fixed(limiter.next_zone_upper_bound, 32)
      .fixed(limiter.last_step_checkpoints.length, 2).raw(Bytes.concat(...limiter.last_step_checkpoints.map(decode)))
      .fixed(limiter.checkpoints.length, 2).raw(Bytes.concat(...limiter.checkpoints.map(decode)))
      .sizedBytes(optionalBytes(poa2.chunk), 24).sizedBytes(decode(block.reward_key), 16)
      .sizedBytes(optionalBytes(poa2.tx_path), 24).sizedBytes(optionalBytes(poa2.data_path), 24)
      .sizedInteger(block.price_per_gib_minute, 8).sizedInteger(block.scheduled_price_per_gib_minute, 8)
      .raw(decode(block.reward_history_hash)).sizedInteger(block.debt_supply, 8)
      .fixed(block.kryder_plus_rate_multiplier, 3).fixed(block.kryder_plus_rate_multiplier_latch, 1)
      .fixed(block.denomination, 3).sizedInteger(block.redenomination_height, 8)
      .sizedInteger(block.previous_cumulative_diff, 16)
      .raw(BlockHash.doubleSigningProofBytes(block.double_signing_proof));
    // From 2.7.
    writer.sizedInteger(block.merkle_rebase_support_threshold, 16).raw(decode(block.chunk_hash))
      .sizedBytes(decode(block.chunk2_hash), 8).raw(decode(block.block_time_history_hash))
      .sizedInteger(limiter.vdf_difficulty, 8).sizedInteger(limiter.next_vdf_difficulty, 8);
    // From 2.8 and 2.9.
    writer.fixed(block.packing_difficulty, 1)
      .sizedBytes(decode(block.unpacked_chunk_hash), 8).sizedBytes(decode(block.unpacked_chunk2_hash), 8)
      .sizedBytes(optionalBytes(poa.unpacked_chunk), 24).sizedBytes(optionalBytes(poa2.unpacked_chunk), 24)
      .fixed(block.replica_format ?? 0, 1);
    return writer.bytes();
  }
}
