// apps/browser/publishing-panel.js — turning a real solution into a block on mainnet: keeping a
// light client's chain state (every account once, from a node, then each new block applied
// and checked), and on a solution, building, signing and posting the block to nodes.
// Its methods are mixed into BrowserNodeApp (see app.js), so `this` is the app.
import { Bytes } from '../../src/core/bytes.js';
import { AccountTree } from '../../src/blocks/account-tree.js';
import { ChainState } from '../../src/blocks/assembler.js';
import { BlockPublisher } from '../../src/blocks/block-publisher.js';
import { ChainFollower } from '../../src/blocks/chain-follower.js';
import { BlockTimeHistory } from '../../src/blocks/history.js';
import { RewardHistory } from '../../src/blocks/rewards.js';
import { BlockSigner } from '../../src/blocks/signer.js';
import { DoubleSigningGuard, MemoryStorage } from '../../src/blocks/signing-guard.js';
import { ComputedVdfSteps, RecordedVdfSteps } from '../../src/blocks/vdf-info.js';
import { NodeClient } from '../../src/network/node-client.js';
import { PendingTransactionPool } from '../../src/network/pending-transactions.js';
import { TransactionPicker } from '../../src/blocks/transaction-picker.js';
import { PeerAccess } from '../../src/network/peers.js';
import { BundledResources } from './resources.js';

export class PublishingPanel {
  /** Nodes a block is posted to; more reach the network faster. */
  static POST_NODE_COUNT = 8;
  /**
   * A saved chain state at most this many blocks behind is caught up block by block; an
   * older one is read again from a node (about 2 minutes a block, so 200 is most of a day).
   */
  static MAX_CATCH_UP_BLOCKS = 200;
  /**
   * The most pending transactions one block carries. Nodes allow 1000; fewer keeps the
   * block small, so it travels to nodes quickly (blocks rarely carry more than 20).
   */
  static MAX_CARRIED_TRANSACTIONS = 300;
  /** The followed state is saved after this many blocks (saving takes about a second). */
  static SAVE_EVERY_BLOCKS = 10;

  /** Why this tab cannot publish a block now, with what to do about it; null if it can. */
  publishBlocker() {
    if (this.isTestMode) return 'Test settings are on, so solutions are not real; untick them to publish.';
    if (!this.usingRealRandomx) return 'RandomX could not start in this browser, so solutions would not be real.';
    if (this.blockOrigin !== 'live') return 'Mining a sample block; load the live block to mine for real.';
    // Replayed steps are old, and steps computed here fall ever further behind the network's,
    // so a solution on them would come after newer blocks and could not be built on the tip.
    const keepsPace = this.view.elements.vdfModeServer.checked || (this.network.stepsComputedHere && this.view.elements.vdfModeLocal.checked);
    if (!keepsPace) return 'Only VDF steps from a server keep pace with the network; choose "Live: steps from every VDF server that answers" in Mine (on an https copy, servers need insecure content allowed).';
    if (!this.identity?.wallet) return 'Mining for an address without its key, so a block could not be signed; use the shared key or a keyfile.';
    const blocked = PeerAccess.blockedReason();
    if (blocked) return `Publishing needs Arweave nodes directly, and ${blocked}. Allow insecure content for this site in the browser's settings and reload, or use the downloaded copy.`;
    return null;
  }

  setPublishStatus(text) {
    this.view.setText('publishStatus', text);
  }

  /** Nodes to read state from and post to: found peers, then gathered ones. */
  publishNodeUrls() {
    if (this.network.nodeUrls) return this.network.nodeUrls;
    const gathered = BundledResources.gatheredSources().nodes ?? [];
    return [...new Set([...(this.peerUrls ?? []), ...gathered.map((entry) => entry.url)])];
  }

  /**
   * Builds the chain state at the tip from one node: all accounts (about 300,000, a few
   * tens of MB, hashed here to check them against the block's root) and the histories.
   * Runs in the background when real mining starts; the status line follows it.
   */
  async prepareToPublish() {
    const blocker = this.publishBlocker();
    if (blocker) {
      this.setPublishStatus(`Not publishing: ${blocker}`);
      return;
    }
    if (this.preparingFollower) return;
    this.preparingFollower = true;
    this.follower = null;
    try {
      const urls = this.publishNodeUrls();
      if (!urls.length) {
        this.setPublishStatus('Not publishing: no Arweave nodes known yet. Press "Find gateways and peers" in Network, then start again.');
        return;
      }
      const tip = this.block;
      if (await this.resumeSavedChainState(tip, urls)) return;
      for (const url of urls) {
        const node = new NodeClient(url, { timeoutMs: 60000 });
        try {
          this.setPublishStatus(`Getting ready to publish: reading accounts at block ${tip.height} from ${url}…`);
          const accounts = await node.walletList(tip.wallet_list, { onPage: (count) => this.setPublishStatus(`Getting ready to publish: read ${count.toLocaleString()} accounts from ${url}…`) });
          this.setPublishStatus(`Getting ready to publish: checking ${accounts.length.toLocaleString()} accounts against block ${tip.height}'s root (this takes a minute)…`);
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
            block: tip, accountTree, recentBlocks: [{ indepHash: tip.indep_hash, txIds: tip.txs ?? [] }], rules: this.network.rules,
            rewardHistory: RewardHistory.fromBinary(await node.rewardHistory(tip.indep_hash)),
            blockTimeHistory: BlockTimeHistory.fromBinary(await node.blockTimeHistory(tip.indep_hash)),
          });
          this.startFollowing(this.followerFor(state), urls);
          this.saveChainState();
          this.setPublishStatus(`Ready to publish: following the chain at block ${tip.height}. A real solution becomes a block posted to ${this.publishNodes.length} nodes.`);
          this.view.log(`ready to publish: chain state at block ${tip.height} from ${url}`, 'good');
          return;
        } catch (error) {
          this.view.log(`could not get chain state from ${url}: ${error.message.split('\n')[0]}`, 'warn');
        }
      }
      this.setPublishStatus('Not publishing: no node gave the accounts and histories a block is built on. Find more peers in Network, then start again.');
    } finally {
      this.preparingFollower = false;
    }
  }

  followerFor(state) {
    return new ChainFollower({ state, fetchTransaction: (id) => this.gateway.request(`/tx/${id}`) });
  }

  /** Makes `follower` the one blocks are built on (only once it is at the tip, so followToTip never races it). */
  startFollowing(follower, urls) {
    this.follower = follower;
    this.publishNodes = urls.slice(0, PublishingPanel.POST_NODE_COUNT).map((nodeUrl) => new NodeClient(nodeUrl, { timeoutMs: 30000 }));
    this.blocksSinceSave = 0;
  }

  /** Saves the followed state for the next visit, in the background; failures are logged by the store. */
  async saveChainState() {
    const state = this.follower?.state;
    if (!state) return;
    this.blocksSinceSave = 0;
    if (await this.chainStateStore.save(state)) this.view.log(`saved the chain state at block ${state.block.height} for next time`);
  }

  /**
   * Picks up the state saved on an earlier visit and follows it to `tip`. Resolves whether
   * that worked; if not (none saved, too old, or on a fork), the state is read afresh.
   */
  async resumeSavedChainState(tip, urls) {
    const state = await this.chainStateStore.load().catch((error) => {
      this.view.log(`the saved chain state could not be read (${error.message}); reading it again`, 'warn');
      return null;
    });
    if (!state) return false;
    const behind = Number(tip.height) - Number(state.block.height);
    if (behind < 0 || behind > PublishingPanel.MAX_CATCH_UP_BLOCKS) {
      this.view.log(`the saved chain state is at block ${state.block.height}, ${behind < 0 ? 'past the tip' : `${behind} blocks behind`}; reading it again`);
      return false;
    }
    const follower = this.followerFor(state);
    try {
      this.setPublishStatus(`Getting ready to publish: catching up ${behind} blocks from the saved state at block ${state.block.height}…`);
      await this.advanceFollower(follower, tip);
    } catch (error) {
      this.view.log(`the saved chain state does not lead to the tip (${error.message}); reading it again`, 'warn');
      return false;
    }
    this.startFollowing(follower, urls);
    this.saveChainState();
    this.setPublishStatus(`Ready to publish: following the chain at block ${tip.height}. A real solution becomes a block posted to ${this.publishNodes.length} nodes.`);
    this.view.log(`ready to publish: caught up ${behind} blocks from the saved chain state`, 'good');
    return true;
  }

  /** Applies the blocks after `follower`'s state up to `tip`; throws where one does not follow. */
  async advanceFollower(follower, tip) {
    while (Number(follower.state.block.height) < Number(tip.height)) {
      const height = Number(follower.state.block.height) + 1;
      const block = height === Number(tip.height) ? tip : await this.gateway.request(`/block/height/${height}`);
      await follower.apply(block);
      this.blocksSinceSave = (this.blocksSinceSave ?? 0) + 1;
    }
  }

  /** Applies the blocks up to `tip` to the followed state; on a mismatch, starts over. */
  async followToTip(tip) {
    if (!this.follower) return;
    try {
      await this.advanceFollower(this.follower, tip);
      if (this.blocksSinceSave >= PublishingPanel.SAVE_EVERY_BLOCKS) this.saveChainState();
      this.setPublishStatus(`Ready to publish: following the chain at block ${this.follower.state.block.height}.`);
      this.refreshPendingTransactions();
    } catch (error) {
      this.view.log(`lost track of the chain (${error.message}); reading it again`, 'warn');
      this.follower = null;
      this.prepareToPublish();
    }
  }

  /** Pending transactions, fetched through the gateway's sources (asking two at most for each). */
  pendingTransactions() {
    this.pendingPool ??= new PendingTransactionPool({
      source: { get: (path) => this.gateway.request(path, { maxSources: 2, timeoutMs: 10000 }) },
      log: (message) => this.view.log(message, 'warn'),
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
      const { picked, rejected } = await TransactionPicker.pick(this.pendingTransactions().candidates(), this.follower.state, { limit: PublishingPanel.MAX_CARRIED_TRANSACTIONS });
      const reasons = new Map();
      for (const { reason } of rejected) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      const left = [...reasons].map(([reason, count]) => `${count} ${reason}`).join('; ');
      this.view.log(`carrying ${picked.length} pending transactions${left ? `; left out: ${left}` : ''}`);
      return picked;
    } catch (error) {
      this.view.log(`carrying no transactions: picking them failed (${error.message})`, 'warn');
      return [];
    }
  }

  /**
   * The VDF facts a node checks first (ar_block_pre_validator, the global step number check):
   * a node takes a posted block only if its step is past its parent's, it lists exactly the
   * steps between (JSON `checkpoints`), and its prev_output is the parent's output. A 200 reply only means the
   * block arrived, so these say why one might still be dropped.
   */
  static vdfSummary(block, parent) {
    const info = block.nonce_limiter_info;
    const parentInfo = parent.nonce_limiter_info;
    const stepsBetween = Number(info.global_step_number) - Number(parentInfo.global_step_number);
    return `block ${block.height} VDF: step ${info.global_step_number} after parent step ${parentInfo.global_step_number} (${stepsBetween} between), `
      + `${info.checkpoints?.length ?? 'no'} steps listed, prev_output ${info.prev_output === parentInfo.output ? 'is' : 'is NOT'} the parent's output`;
  }

  blockSigner() {
    if (!this.blockSignerFor || this.blockSignerFor.wallet !== this.identity.wallet) {
      this.blockSignerFor = new BlockSigner({ wallet: this.identity.wallet, guard: new DoubleSigningGuard({ storage: MemoryStorage.browserOrMemory() }) });
    }
    return this.blockSignerFor;
  }

  /** Builds, signs and posts the block for a real solution; reports each stage. */
  async publishSolution(report) {
    const blocker = this.publishBlocker() ?? (this.follower ? null : 'the chain state is not ready yet (see the status line).');
    if (blocker) {
      this.view.log(`solution not published: ${blocker}`, 'warn');
      return;
    }
    const parent = this.follower.state.block;
    const signer = this.blockSigner();
    const earlier = signer.guard.signedChildOf(this.identity.address, parent.cumulative_diff);
    if (earlier) {
      // A second block on this parent would be a double signature; only a newer tip helps.
      this.setPublishStatus(`Waiting for the chain to pass height ${earlier.height}: this key already signed a block there (signed hash ${earlier.blockHash.slice(0, 12)}…), so the solution at step ${report.stepNumber.toLocaleString()} is skipped.`);
      return;
    }
    this.setPublishStatus(`Building the block for the solution at step ${report.stepNumber.toLocaleString()}…`);
    const parentStep = Number(parent.nonce_limiter_info.global_step_number);
    await this.vdfPool?.fillSince(parentStep, report.stepNumber);
    const publisher = new BlockPublisher({
      follower: this.follower, signer, fetchChunkJson: (offset) => this.gateway.chunkJson(offset),
      nodes: this.publishNodes, h0Hasher: this.h0Hasher, entropySource: this.entropySource, log: (message) => this.view.log(message),
    });
    try {
      const { block, replies } = await publisher.publish({
        report, transactions: await this.transactionsToCarry(), stepSource: new RecordedVdfSteps(this.vdfSteps.outputsByStep, new ComputedVdfSteps(), this.vdfSteps.checkpointsByStep),
      });
      const taken = replies.filter((reply) => reply.status === 200 || reply.status === 208);
      this.view.log(PublishingPanel.vdfSummary(block, parent));
      if (taken.length) this.checkTipNow({ awaitedHash: block.indep_hash });
      const summary = replies.map((reply) => `${reply.node} ${reply.status || 'unreachable'}${reply.text ? ` ${reply.text.slice(0, 60)}` : ''}`).join('; ');
      this.setPublishStatus(`Posted block ${block.height} (${block.indep_hash.slice(0, 12)}…): ${taken.length} of ${replies.length} nodes took it. ${summary}`);
      this.view.log(`posted block ${block.height}: ${summary}`, taken.length ? 'good' : 'warn');
    } catch (error) {
      this.setPublishStatus(`The solution did not become a block — ${error.message}`);
      this.view.log(`publishing failed at ${error.stage ?? 'an unexpected step'}: ${error.message}`, 'error');
    }
  }
}
