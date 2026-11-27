// apps/browser/publishing-panel.js — the page's side of publishing: when this tab may publish,
// which nodes it uses, and the status line. The chain state and the block building itself
// are PublishingNode's (src/blocks/publishing-node.js), owned as `this.publishing`.
// Its methods are mixed into BrowserNodeApp (see app.js), so `this` is the app.
import { PublishingNode } from '../../src/blocks/publishing-node.js';
import { ComputedVdfSteps, RecordedVdfSteps } from '../../src/blocks/vdf-info.js';
import { PeerAccess } from '../../src/network/peers.js';
import { BundledResources } from './resources.js';

export class PublishingPanel {
  /** The publishing half of this node, made once the gateway and stores exist. */
  get publishing() {
    this.publishingNode ??= new PublishingNode({
      gateway: this.gateway, chainStateStore: this.chainStateStore, rules: this.network.rules,
      log: (message, level) => this.view.log(message, level), onStatus: (text) => this.setPublishStatus(text),
    });
    return this.publishingNode;
  }

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
   * Gets the chain state at the tip ready in the background when real mining starts; the
   * status line follows it.
   */
  async prepareToPublish() {
    const blocker = this.publishBlocker();
    if (blocker) {
      this.setPublishStatus(`Not publishing: ${blocker}`);
      return;
    }
    if (this.publishing.preparing) return;
    let urls = this.publishNodeUrls();
    if (!urls.length) {
      // No nodes gathered with this copy (or the gathering failed): look for peers now
      // rather than ask the person to, since the one-button start relies on this.
      this.setPublishStatus('Getting ready to publish: looking for Arweave nodes…');
      await this.findPeers();
      urls = this.publishNodeUrls();
    }
    if (!urls.length) {
      this.setPublishStatus('Not publishing: no Arweave node answered. "Find gateways and peers" in Network tries again; the activity log says why each failed.');
      return;
    }
    await this.publishing.prepare(this.block, urls);
  }

  /** Follows a new tip; if the followed state no longer leads there, reads it again. */
  async followToTip(tip) {
    if (!(await this.publishing.followToTip(tip))) this.prepareToPublish();
  }

  /** Builds, signs and posts the block for a real solution; reports each stage. */
  async publishSolution(report) {
    const blocker = this.publishBlocker() ?? (this.publishing.ready ? null : 'the chain state is not ready yet (see the status line).');
    if (blocker) {
      this.view.log(`solution not published: ${blocker}`, 'warn');
      return;
    }
    const parentStep = Number(this.publishing.parentBlock.nonce_limiter_info.global_step_number);
    await this.vdfPool?.fillSince(parentStep, report.stepNumber);
    const published = await this.publishing.publish(report, {
      wallet: this.identity.wallet, address: this.identity.address,
      stepSource: new RecordedVdfSteps(this.vdfSteps.outputsByStep, new ComputedVdfSteps(), this.vdfSteps.checkpointsByStep),
      h0Hasher: this.h0Hasher, entropySource: this.entropySource,
    });
    if (published?.taken.length) this.checkTipNow({ awaitedHash: published.block.indep_hash });
  }
}
