// src/blocks/chain-follower.js — keeps a ChainState current by applying each new block, as a light
// client does: the block's transactions and released reward change the account tree, whose
// root must then equal the block's wallet_list; the histories gain the block's entries. A
// state kept this way is ready to build the next block on the moment a solution is found,
// without fetching all accounts again.
import { Bytes } from '../core/bytes.js';
import { BlockAssembler } from './assembler.js';
import { BlockTransactions } from './block-transactions.js';
import { BlockVerifier } from './block-verifier.js';

export class ChainFollowError extends Error {
  /** A block that does not follow from the state (wrong parent, or a different root). */
  constructor(message, { block, expected, computed } = {}) {
    super(message);
    Object.assign(this, { block, expected, computed });
  }
}

export class ChainFollower {
  /**
   * `state` is a ChainState at some block; `fetchTransaction(id)` resolves a
   * transaction's JSON (GET /tx/{id}), needed to apply a block's transactions.
   */
  constructor({ state, fetchTransaction }) {
    Object.assign(this, { state, fetchTransaction });
  }

  /**
   * Applies `block` (JSON) on top of the state, in the node's order (update_accounts):
   * transactions first, then the oldest locked reward is released. Throws
   * ChainFollowError, leaving the account tree changed, if the block does not follow;
   * the caller should then rebuild the state from a node.
   */
  async apply(block) {
    const parent = this.state.block;
    if (block.previous_block !== parent.indep_hash) {
      throw new ChainFollowError(`block ${block.height} is not on ${parent.height} (${parent.indep_hash.slice(0, 12)}…)`, { block });
    }
    // A peer could hand over a forged block; its id and signature must check out first.
    const forged = await BlockVerifier.problem(block);
    if (forged) throw new ChainFollowError(`block ${block.height} is not genuine: ${forged}`, { block });
    if (block.double_signing_proof && Object.keys(block.double_signing_proof).length) {
      throw new ChainFollowError(`block ${block.height} carries a double-signing proof, whose ban and prover reward are not implemented`, { block });
    }
    const transactions = await Promise.all((block.txs ?? []).map((id) => this.fetchTransaction(id)));
    await BlockTransactions.applyToAccounts(this.state.accountTree, transactions, this.state.rewardHistory.releasedReward(), Number(parent.denomination));

    const computed = Bytes.toBase64Url(await this.state.accountTree.rootHash());
    if (computed !== block.wallet_list) {
      throw new ChainFollowError(`block ${block.height}: our account root ${computed.slice(0, 12)}… is not its wallet_list ${block.wallet_list.slice(0, 12)}…`, { block, expected: block.wallet_list, computed });
    }
    BlockAssembler.advance(this.state, block);
    return { height: Number(block.height), transactionCount: transactions.length };
  }
}
