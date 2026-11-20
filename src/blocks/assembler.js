// src/blocks/assembler.js — a whole (empty) block from its parent's state and a mining
// solution, ready to sign: the parts of steps 1–3 put together. Step 5 of docs/TODO.md
// "Turn a solution into a block".
import { Bytes } from '../core/bytes.js';
import { BlockHistoryHashes, BlockTimeHistory } from './history.js';
import { NextBlockFields } from './fields.js';
import { NetworkRules } from './network-rules.js';

export class ChainState {
  /**
   * What a node keeps about the tip that the next block is computed from: the block itself
   * (JSON as nodes serve it), its reward history and block-time history, and the account
   * tree at that block. `advance` moves it to a new block in place. `rules` are the
   * network's (NetworkRules.MAINNET, or LOCALNET for Arweave's test chain).
   */
  constructor({ block, rewardHistory, blockTimeHistory, accountTree, rules = NetworkRules.MAINNET }) {
    Object.assign(this, { block, rewardHistory, blockTimeHistory, accountTree, rules });
  }
}

export class BlockAssembler {
  /** The fields a mining solution supplies, named as in block JSON. */
  static SOLUTION_FIELDS = [
    'nonce', 'hash', 'hash_preimage', 'recall_byte', 'recall_byte2', 'partition_number',
    'nonce_limiter_info', 'poa', 'poa2', 'chunk_hash', 'chunk2_hash', 'unpacked_chunk_hash',
    'unpacked_chunk2_hash', 'packing_difficulty', 'replica_format',
  ];

  /**
   * The next block on `state` (a ChainState), unsigned. `solution` holds SOLUTION_FIELDS;
   * `rewardAddress` the miner's address (base64url) and `rewardKey` its public key;
   * `timestamp` the miner's clock in seconds.
   *
   * The account tree is left as it was (the oldest locked reward is released only to work
   * out the root, then put back), so a block that is never accepted costs nothing.
   */
  static async assemble({ state, solution, rewardAddress, rewardKey, timestamp }) {
    const parent = state.block;
    const fields = NextBlockFields.compute({
      parent, parentBlockTimeHistory: state.blockTimeHistory, parentRewardHistory: state.rewardHistory, timestamp, difficultyRetargets: state.rules.difficultyRetargets,
    });
    const block = {
      ...fields,
      ...Object.fromEntries(BlockAssembler.SOLUTION_FIELDS.filter((name) => name in solution).map((name) => [name, solution[name]])),
      reward_addr: rewardAddress,
      reward_key: rewardKey,
      tags: [],
      double_signing_proof: {},
      packing_2_5_threshold: parent.packing_2_5_threshold,
      strict_data_split_threshold: parent.strict_data_split_threshold,
    };

    // The release is undone once the root is known: the state moves on only by following
    // whichever block the network keeps (ChainFollower, or `advance`).
    const released = state.rewardHistory.releasedReward();
    block.wallet_list = await state.accountTree.withUndoneChanges(async (tree) => {
      tree.applyReward(released.addressBytes, released.reward, Number(parent.denomination));
      return Bytes.toBase64Url(await tree.rootHash());
    });
    block.reward_history_hash = Bytes.toBase64Url(BlockHistoryHashes.rewardHistoryHash(block, Bytes.fromBase64Url(parent.reward_history_hash)));
    block.block_time_history_hash = Bytes.toBase64Url(state.blockTimeHistory.withNewest(BlockTimeHistory.elementFor(block, parent)).hash());
    block.hash_list_merkle = Bytes.toBase64Url(await BlockHistoryHashes.hashListMerkle(parent));
    return block;
  }

  /** Moves `state` onto `block` once it is accepted: its histories gain the block's entries. */
  static advance(state, block) {
    const rewardEntry = {
      addressBytes: Bytes.fromBase64Url(block.reward_addr), hashRate: BlockHistoryHashes.hashRate(block.diff),
      reward: BigInt(block.reward), denomination: Number(block.denomination),
    };
    state.rewardHistory = new state.rewardHistory.constructor([rewardEntry, ...state.rewardHistory.entries]);
    state.blockTimeHistory = state.blockTimeHistory.withNewest(BlockTimeHistory.elementFor(block, state.block));
    state.block = block;
  }
}
