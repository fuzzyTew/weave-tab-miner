// src/blocks/publishing-node.js — the publishing half of a light node: keeps the chain state at
// the tip (every account once, from a node, then each new block applied and checked) and
// turns a real solution into a block posted to nodes. No page or DOM: a browser page, a
// node program or a test drives it, and hears back through `log` and `onStatus`.

import { Bytes } from '../core/bytes.js';
import { AccountTree } from './account-tree.js';
import { ChainState } from './assembler.js';
import { BlockPublisher } from './block-publisher.js';
import { ChainFollower } from './chain-follower.js';
import { BlockTimeHistory } from './history.js';
import { RewardHistory } from './rewards.js';
import { BlockSigner } from './signer.js';
import { DoubleSigningGuard, MemoryStorage } from './signing-guard.js';
import { TransactionPicker } from './transaction-picker.js';
import { NodeClient } from '../network/node-client.js';
import { PendingTransactionPool } from '../network/pending-transactions.js';

export class PublishingNode {
  /**
   * Owns the followed chain state, the nodes blocks go to, the pending transaction pool and
   * the block signer, so no other code keeps a copy of them.
   *
   * `gateway` answers request(path, options) and chunkJson(offset) (an ArweaveGateway);
   * `chainStateStore` saves and loads a ChainState between visits (load/save, or null to
   * keep nothing); `rules` are the network's (NetworkTarget.rules); `log(message, level)`
   * hears what happened ('good', 'warn' or 'error' levels, or none); `onStatus(text)` hears
   * a one-line state for a status display. `signingGuardStorage` keeps which heights a key
   * has signed (so a restart cannot sign twice at one height).
   */
  constructor({
    gateway, chainStateStore = null, rules, log = () => {}, onStatus = () => {},
    signingGuardStorage = MemoryStorage.browserOrMemory(),
    postNodeCount = 8, maxCatchUpBlocks = 200, saveEveryBlocks = 10, maxCarriedTransactions = 300,
    accountReadTimeoutMs = 60_000, postTimeoutMs = 30_000,
  }) {
    Object.assign(this, {
      gateway, chainStateStore, rules, log, onStatus, signingGuardStorage,
      postNodeCount, maxCatchUpBlocks, saveEveryBlocks, maxCarriedTransactions, accountReadTimeoutMs, postTimeoutMs,
    });
    this.follower = null; // the followed chain state, once at the tip
    this.publishNodes = [];
    this.blocksSinceSave = 0;
    this.preparing = false;
    this.signer = null;
    this.pendingPool = null;
    this.pendingSummary = '';
  }

  /** Whether blocks can be built now: the chain state is at the tip. */
  get ready() {
    return Boolean(this.follower);
  }

  /** The block the next one would build on, or null. */
  get parentBlock() {
    return this.follower?.state.block ?? null;
  }

  // ---- getting to the tip ----

  /**
   * Gets the chain state at `tip`: from the state saved on an earlier visit if it leads
   * there, else from the first of `nodeUrls` that gives all accounts (about 300,000, a few
   * tens of MB, hashed here to check them against the block's root) and the histories.
   * Resolves whether it is ready. A second call while one runs resolves false at once.
   */
  async prepare(tip, nodeUrls) {
    if (this.preparing) return false;
    this.preparing = true;
    this.follower = null;
    try {
      if (await this.resumeSaved(tip, nodeUrls)) return true;
      for (const url of nodeUrls) {
        try {
          await this.readStateFrom(url, tip, nodeUrls);
          return true;
        } catch (error) {
          this.log(`could not get chain state from ${url}: ${error.message.split('\n')[0]}`, 'warn');
        }
      }
      this.onStatus('Not publishing: no node gave the accounts and histories a block is built on. Find more peers, then start again.');
      return false;
    } finally {
      this.preparing = false;
    }
  }

  /** Reads the whole state at `tip` from one node and follows it; throws if the node fails. */
  async readStateFrom(url, tip, nodeUrls) {
    const node = new NodeClient(url, { timeoutMs: this.accountReadTimeoutMs });
    this.onStatus(`Getting ready to publish: reading accounts at block ${tip.height} from ${url}…`);
    const accounts = await node.walletList(tip.wallet_list, { onPage: (count) => this.onStatus(`Getting ready to publish: read ${count.toLocaleString()} accounts from ${url}…`) });
    this.onStatus(`Getting ready to publish: checking ${accounts.length.toLocaleString()} accounts against block ${tip.height}'s root (this takes a minute)…`);
    const accountTree = new AccountTree();
    for (const [index, json] of accounts.entries()) {
      const { addressBytes, account } = AccountTree.accountFromJson(json);
      accountTree.insert(addressBytes, account);
      // Let mining and the page run between batches of a few thousand.
      if (index % 5000 === 4999) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (Bytes.toBase64Url(await accountTree.rootHash()) !== tip.wallet_list) throw new Error('its accounts do not hash to the block\'s root');
    // Only the tip is known as a recent block at first (each is up to a megabyte with its
    // proofs); following adds one a block, so transactions anchored to older blocks wait
    // (see TransactionPicker.pick for why fewer stay safe).
    const state = new ChainState({
      block: tip, accountTree, recentBlocks: [{ indepHash: tip.indep_hash, txIds: tip.txs ?? [] }], rules: this.rules,
      rewardHistory: RewardHistory.fromBinary(await node.rewardHistory(tip.indep_hash)),
      blockTimeHistory: BlockTimeHistory.fromBinary(await node.blockTimeHistory(tip.indep_hash)),
    });
    this.startFollowing(this.followerFor(state), nodeUrls);
    this.saveState();
    this.onStatus(`Ready to publish: following the chain at block ${tip.height}. A real solution becomes a block posted to ${this.publishNodes.length} nodes.`);
    this.log(`ready to publish: chain state at block ${tip.height} from ${url}`, 'good');
  }

  /**
   * Picks up the state saved on an earlier visit and follows it to `tip`. Resolves whether
   * that worked; if not (none saved, too old, or on a fork), the caller reads it afresh.
   */
  async resumeSaved(tip, nodeUrls) {
    if (!this.chainStateStore) return false;
    const state = await this.chainStateStore.load().catch((error) => {
      this.log(`the saved chain state could not be read (${error.message}); reading it again`, 'warn');
      return null;
    });
    if (!state) return false;
    const behind = Number(tip.height) - Number(state.block.height);
    if (behind < 0 || behind > this.maxCatchUpBlocks) {
      this.log(`the saved chain state is at block ${state.block.height}, ${behind < 0 ? 'past the tip' : `${behind} blocks behind`}; reading it again`);
      return false;
    }
    const follower = this.followerFor(state);
    try {
      this.onStatus(`Getting ready to publish: catching up ${behind} blocks from the saved state at block ${state.block.height}…`);
      await this.advance(follower, tip);
    } catch (error) {
      this.log(`the saved chain state does not lead to the tip (${error.message}); reading it again`, 'warn');
      return false;
    }
    this.startFollowing(follower, nodeUrls);
    this.saveState();
    this.onStatus(`Ready to publish: following the chain at block ${tip.height}. A real solution becomes a block posted to ${this.publishNodes.length} nodes.`);
    this.log(`ready to publish: caught up ${behind} blocks from the saved chain state`, 'good');
    return true;
  }

  followerFor(state) {
    return new ChainFollower({ state, fetchTransaction: (id) => this.gateway.request(`/tx/${id}`) });
  }

  /** Makes `follower` the one blocks are built on (only once it is at the tip, so followToTip never races it). */
  startFollowing(follower, nodeUrls) {
    this.follower = follower;
    this.publishNodes = nodeUrls.slice(0, this.postNodeCount).map((nodeUrl) => new NodeClient(nodeUrl, { timeoutMs: this.postTimeoutMs }));
    this.blocksSinceSave = 0;
  }

  /** Saves the followed state for the next visit, in the background; failures are logged by the store. */
  async saveState() {
    const state = this.follower?.state;
    if (!state || !this.chainStateStore) return;
    this.blocksSinceSave = 0;
    if (await this.chainStateStore.save(state)) this.log(`saved the chain state at block ${state.block.height} for next time`);
  }

  /** Applies the blocks after `follower`'s state up to `tip`; throws where one does not follow. */
  async advance(follower, tip) {
    while (Number(follower.state.block.height) < Number(tip.height)) {
      const height = Number(follower.state.block.height) + 1;
      const block = height === Number(tip.height) ? tip : await this.gateway.request(`/block/height/${height}`);
      await follower.apply(block);
      this.blocksSinceSave++;
    }
  }

  /**
   * Applies the blocks up to `tip` to the followed state. Resolves true when followed, or
   * false when they did not follow (a fork or a bad block): the state is dropped, and the
   * caller prepares again.
   */
  async followToTip(tip) {
    if (!this.follower) return true;
    try {
      await this.advance(this.follower, tip);
      if (this.blocksSinceSave >= this.saveEveryBlocks) this.saveState();
      this.onStatus(`Ready to publish: following the chain at block ${this.follower.state.block.height}.`);
      this.refreshPendingTransactions();
      return true;
    } catch (error) {
      this.log(`lost track of the chain (${error.message}); reading it again`, 'warn');
      this.follower = null;
      return false;
    }
  }

  // ---- pending transactions ----

  /** Pending transactions, fetched through the gateway's sources (asking two at most for each). */
  pendingTransactions() {
    this.pendingPool ??= new PendingTransactionPool({
      source: { get: (path) => this.gateway.request(path, { maxSources: 2, timeoutMs: 10_000 }) },
      log: (message) => this.log(message, 'warn'),
    });
    return this.pendingPool;
  }

  /** Refreshes the pending transactions in the background; a failure only means fewer are carried. */
  async refreshPendingTransactions() {
    try {
      const { pending, held, failed } = await this.pendingTransactions().refresh();
      this.pendingSummary = `${held} of ${pending} pending transactions held${failed ? ` (${failed} not fetched)` : ''}`;
    } catch (error) {
      this.pendingSummary = `pending transactions unavailable: ${error.message.split('\n')[0]}`;
    }
  }

  /**
   * The pending transactions a block on the followed state can surely carry. Any failure
   * gives none: a block without them is still a block, while one bad transaction would
   * make the whole block invalid.
   */
  async transactionsToCarry() {
    try {
      const { picked, rejected } = await TransactionPicker.pick(this.pendingTransactions().candidates(), this.follower.state, { limit: this.maxCarriedTransactions });
      const reasons = new Map();
      for (const { reason } of rejected) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      const left = [...reasons].map(([reason, count]) => `${count} ${reason}`).join('; ');
      this.log(`carrying ${picked.length} pending transactions${left ? `; left out: ${left}` : ''}`);
      return picked;
    } catch (error) {
      this.log(`carrying no transactions: picking them failed (${error.message})`, 'warn');
      return [];
    }
  }

  // ---- publishing ----

  /** The signer for `wallet`, kept while the wallet stays the same (its guard remembers heights). */
  signerFor(wallet) {
    if (this.signer?.wallet !== wallet) this.signer = new BlockSigner({ wallet, guard: new DoubleSigningGuard({ storage: this.signingGuardStorage }) });
    return this.signer;
  }

  /**
   * The VDF facts a node checks first (ar_block_pre_validator, the global step number check):
   * a node takes a posted block only if its step is past its parent's, it lists exactly the
   * steps between (JSON `checkpoints`), and its prev_output is the parent's output. A 200
   * reply only means the block arrived, so these say why one might still be dropped.
   */
  static vdfSummary(block, parent) {
    const info = block.nonce_limiter_info;
    const parentInfo = parent.nonce_limiter_info;
    const stepsBetween = Number(info.global_step_number) - Number(parentInfo.global_step_number);
    return `block ${block.height} VDF: step ${info.global_step_number} after parent step ${parentInfo.global_step_number} (${stepsBetween} between), `
      + `${info.checkpoints?.length ?? 'no'} steps listed, prev_output ${info.prev_output === parentInfo.output ? 'is' : 'is NOT'} the parent's output`;
  }

  /**
   * Builds, signs and posts the block for a real solution (Miner.mineStep's report).
   * `stepSource` gives the VDF steps since the parent; `h0Hasher` and `entropySource` are
   * the miner's. Resolves { block, taken, replies } once posted, or null when it was not
   * (no state yet, the key already signed at this height, or a failure, all reported
   * through onStatus and log).
   */
  async publish(report, { wallet, address, stepSource, h0Hasher, entropySource }) {
    if (!this.follower) {
      this.log('solution not published: the chain state is not ready yet (see the status line).', 'warn');
      return null;
    }
    const parent = this.follower.state.block;
    const signer = this.signerFor(wallet);
    const earlier = signer.guard.signedChildOf(address, parent.cumulative_diff);
    if (earlier) {
      // A second block on this parent would be a double signature; only a newer tip helps.
      this.onStatus(`Waiting for the chain to pass height ${earlier.height}: this key already signed a block there (signed hash ${earlier.blockHash.slice(0, 12)}…), so the solution at step ${report.stepNumber.toLocaleString()} is skipped.`);
      return null;
    }
    this.onStatus(`Building the block for the solution at step ${report.stepNumber.toLocaleString()}…`);
    const publisher = new BlockPublisher({
      follower: this.follower, signer, fetchChunkJson: (offset) => this.gateway.chunkJson(offset),
      nodes: this.publishNodes, h0Hasher, entropySource, log: (message) => this.log(message),
    });
    try {
      const { block, replies } = await publisher.publish({ report, transactions: await this.transactionsToCarry(), stepSource });
      const taken = replies.filter((reply) => reply.status === 200 || reply.status === 208);
      this.log(PublishingNode.vdfSummary(block, parent));
      const summary = replies.map((reply) => `${reply.node} ${reply.status || 'unreachable'}${reply.text ? ` ${reply.text.slice(0, 60)}` : ''}`).join('; ');
      this.onStatus(`Posted block ${block.height} (${block.indep_hash.slice(0, 12)}…): ${taken.length} of ${replies.length} nodes took it. ${summary}`);
      this.log(`posted block ${block.height}: ${summary}`, taken.length ? 'good' : 'warn');
      return { block, taken, replies };
    } catch (error) {
      this.onStatus(`The solution did not become a block — ${error.message}`);
      this.log(`publishing failed at ${error.stage ?? 'an unexpected step'}: ${error.message}`, 'error');
      return null;
    }
  }
}
