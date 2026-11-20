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
import { DoubleSigningGuard } from '../../src/blocks/signing-guard.js';
import { ComputedVdfSteps, RecordedVdfSteps } from '../../src/blocks/vdf-info.js';
import { NodeClient } from '../../src/network/node-client.js';
import { PeerAccess } from '../../src/network/peers.js';
import { BundledResources } from './resources.js';

export class PublishingPanel {
  /** Nodes a block is posted to; more reach the network faster. */
  static POST_NODE_COUNT = 8;

  /** Why this tab cannot publish a block now, with what to do about it; null if it can. */
  publishBlocker() {
    if (this.isTestMode) return 'Test settings are on, so solutions are not real; untick them to publish.';
    if (!this.usingRealRandomx) return 'RandomX could not start in this browser, so solutions would not be real.';
    if (this.blockOrigin !== 'live') return 'Mining a sample block; load the live block to mine for real.';
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
      for (const url of urls) {
        const node = new NodeClient(url, { timeoutMs: 60000 });
        try {
          this.setPublishStatus(`Getting ready to publish: reading accounts at block ${tip.height} from ${url}…`);
          const accounts = await node.walletList(tip.wallet_list, { onPage: (count) => this.setPublishStatus(`Getting ready to publish: read ${count.toLocaleString()} accounts from ${url}…`) });
          this.setPublishStatus(`Getting ready to publish: checking ${accounts.length.toLocaleString()} accounts against block ${tip.height}'s root (this takes a minute)…`);
          const accountTree = new AccountTree();
          for (const json of accounts) {
            const { addressBytes, account } = AccountTree.accountFromJson(json);
            accountTree.insert(addressBytes, account);
          }
          if (Bytes.toBase64Url(await accountTree.rootHash()) !== tip.wallet_list) throw new Error('its accounts do not hash to the block\'s root');
          const state = new ChainState({
            block: tip, accountTree,
            rewardHistory: RewardHistory.fromBinary(await node.rewardHistory(tip.indep_hash)),
            blockTimeHistory: BlockTimeHistory.fromBinary(await node.blockTimeHistory(tip.indep_hash)),
          });
          this.follower = new ChainFollower({ state, fetchTransaction: (id) => this.gateway.request(`/tx/${id}`) });
          this.publishNodes = urls.slice(0, PublishingPanel.POST_NODE_COUNT).map((nodeUrl) => new NodeClient(nodeUrl, { timeoutMs: 30000 }));
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

  /** Applies the blocks up to `tip` to the followed state; on a mismatch, starts over. */
  async followToTip(tip) {
    if (!this.follower) return;
    try {
      while (Number(this.follower.state.block.height) < Number(tip.height)) {
        const height = Number(this.follower.state.block.height) + 1;
        const block = height === Number(tip.height) ? tip : await this.gateway.request(`/block/height/${height}`);
        await this.follower.apply(block);
      }
      this.setPublishStatus(`Ready to publish: following the chain at block ${this.follower.state.block.height}.`);
    } catch (error) {
      this.view.log(`lost track of the chain (${error.message}); reading it again`, 'warn');
      this.follower = null;
      this.prepareToPublish();
    }
  }

  blockSigner() {
    if (!this.blockSignerFor || this.blockSignerFor.wallet !== this.identity.wallet) {
      let storage;
      try {
        storage = localStorage;
      } catch {
        storage = new Map();
        storage.getItem = (key) => storage.get(key) ?? null;
        storage.setItem = (key, value) => storage.set(key, value);
      }
      this.blockSignerFor = new BlockSigner({ wallet: this.identity.wallet, guard: new DoubleSigningGuard({ storage }) });
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
    this.setPublishStatus(`Building the block for the solution at step ${report.stepNumber.toLocaleString()}…`);
    const parentStep = Number(this.follower.state.block.nonce_limiter_info.global_step_number);
    if (this.vdfSteps.missingSteps(parentStep, report.stepNumber).length && this.vdfClient) {
      try {
        this.vdfSteps.add(await this.vdfClient.previousSession());
        this.vdfSteps.add(await this.vdfClient.session());
      } catch (error) {
        this.view.log(`VDF sessions: ${error.message}`, 'warn');
      }
    }
    const publisher = new BlockPublisher({
      follower: this.follower, signer: this.blockSigner(), fetchChunkJson: (offset) => this.gateway.chunkJson(offset),
      nodes: this.publishNodes, h0Hasher: this.h0Hasher, entropySource: this.entropySource, log: (message) => this.view.log(message),
    });
    try {
      const { block, replies } = await publisher.publish({
        report, stepSource: new RecordedVdfSteps(this.vdfSteps.outputsByStep, new ComputedVdfSteps(), this.vdfSteps.checkpointsByStep),
      });
      const taken = replies.filter((reply) => reply.status === 200 || reply.status === 208);
      const summary = replies.map((reply) => `${reply.node} ${reply.status || 'unreachable'}${reply.text ? ` ${reply.text.slice(0, 60)}` : ''}`).join('; ');
      this.setPublishStatus(`Posted block ${block.height} (${block.indep_hash.slice(0, 12)}…): ${taken.length} of ${replies.length} nodes took it. ${summary}`);
      this.view.log(`posted block ${block.height}: ${summary}`, taken.length ? 'good' : 'warn');
    } catch (error) {
      this.setPublishStatus(`The solution did not become a block — ${error.message}`);
      this.view.log(`publishing failed at ${error.stage ?? 'an unexpected step'}: ${error.message}`, 'error');
    }
  }
}
