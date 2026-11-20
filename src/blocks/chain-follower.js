// src/blocks/chain-follower.js — keeps a ChainState current by applying each new block, as a light
// client does: the block's transactions and released reward change the account tree, whose
// root must then equal the block's wallet_list; the histories gain the block's entries. A
// state kept this way is ready to build the next block on the moment a solution is found,
// without fetching all accounts again.
import { Bytes } from '../core/bytes.js';
import { Sha256 } from '../core/sha256.js';
import { BlockAssembler } from './assembler.js';

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
   * A transaction's account-changing fields from its JSON (ar_serialize:json_struct_to_tx):
   * amounts as BigInt; `denomination` absent means 0 (taken as it is). The sender's address
   * is SHA-256 of the owner key, for RSA and secp256k1 keys alike (ar_wallet:to_address).
   */
  static transactionFromJson(json) {
    const ownerBytes = Bytes.fromBase64Url(json.owner ?? '');
    if (!ownerBytes.length) throw new Error(`transaction ${json.id} has no owner key; recovering it from the signature is not implemented`);
    return {
      idBytes: Bytes.fromBase64Url(json.id),
      ownerAddressBytes: Sha256.hash(ownerBytes),
      targetBytes: Bytes.fromBase64Url(json.target ?? ''),
      quantity: BigInt(json.quantity || 0),
      reward: BigInt(json.reward || 0),
      denomination: Number(json.denomination ?? 0),
    };
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
    if (block.double_signing_proof && Object.keys(block.double_signing_proof).length) {
      throw new ChainFollowError(`block ${block.height} carries a double-signing proof, whose ban and prover reward are not implemented`, { block });
    }
    const denomination = Number(parent.denomination);
    const transactions = await Promise.all((block.txs ?? []).map(async (id) => ChainFollower.transactionFromJson(await this.fetchTransaction(id))));
    for (const transaction of transactions) this.state.accountTree.applyTransaction(transaction, denomination);
    const released = this.state.rewardHistory.releasedReward();
    this.state.accountTree.applyReward(released.addressBytes, released.reward, denomination);

    const computed = Bytes.toBase64Url(await this.state.accountTree.rootHash());
    if (computed !== block.wallet_list) {
      throw new ChainFollowError(`block ${block.height}: our account root ${computed.slice(0, 12)}… is not its wallet_list ${block.wallet_list.slice(0, 12)}…`, { block, expected: block.wallet_list, computed });
    }
    BlockAssembler.advance(this.state, block);
    return { height: Number(block.height), transactionCount: transactions.length };
  }
}
