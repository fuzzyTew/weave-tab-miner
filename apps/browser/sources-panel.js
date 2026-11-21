// apps/browser/sources-panel.js — Finding, testing and choosing gateways, nodes and VDF servers.
// Its methods are mixed into BrowserNodeApp (see app.js), so `this` is the app.
import { VdfSession } from '../../src/mining/vdf.js';
import { PeerAccess, PeerDirectory, GatewayDirectory, SourceTester } from '../../src/network/peers.js';
import { VdfServerClient } from '../../src/network/vdf-client.js';
import { BundledResources } from './resources.js';
import { PageView } from './page-view.js';

export class SourcesPanel {
  // ---- network ----

  /**
   * More gateways from an ar.io gateway's registry, then, where this page may reach them,
   * Arweave nodes to try first. Gateways stay the fallback either way.
   */
  async findPeers() {
    this.view.setText('peerStatus', 'Asking ar.io for more gateways…');
    let nodeUrls = [];
    try {
      const found = await new GatewayDirectory({ log: (message) => this.view.log(message, 'warn') }).discover();
      this.gateway.addGateways(found.gatewayUrls);
      nodeUrls = found.nodeUrls;
      this.view.log(`ar.io listed ${found.gatewayUrls.length} more gateways and ${nodeUrls.length} Arweave nodes`, 'good');
    } catch (error) {
      this.view.log(`could not get the ar.io gateway list: ${error.message.split('\n')[0]}`, 'warn');
    }
    const gatewayCount = this.gateway.fallbackUrls.length;

    const blocked = PeerAccess.blockedReason();
    if (blocked) {
      this.view.setText('peerStatus', `Using ${gatewayCount} gateways, not nodes directly: ${blocked}. A downloaded copy, opened from disk, can reach nodes.`);
      this.view.log(`peers unavailable, using gateways: ${blocked}`, 'warn');
      return;
    }
    this.view.setText('peerStatus', `Using ${gatewayCount} gateways; probing Arweave nodes…`);
    try {
      this.peerUrls = await new PeerDirectory({ gateway: this.gateway, log: (message) => this.view.log(message, 'warn') }).discover(nodeUrls);
      this.gateway.preferPeers(this.peerUrls);
      this.view.setText('peerStatus', this.peerUrls.length
        ? `${this.peerUrls.length} nodes answered and are tried first: ${this.peerUrls.join(', ')}. ${gatewayCount} gateways remain the fallback.`
        : `No node answered, so requests go to ${gatewayCount} gateways.`);
    } catch (error) {
      this.view.setText('peerStatus', `Could not get a node list; using ${gatewayCount} gateways.`);
      this.view.log(error.message.split('\n')[0], 'error');
    }
  }

  // ---- a person's own sources ----

  static MIXED_CONTENT_STORAGE_KEY = 'weave-tab-miner.mixed-content-allowed';

  /** Restores and follows the "insecure content allowed" box; hidden where it does not apply. */
  setUpMixedContentChoice() {
    const { mixedContentCheckbox, mixedContentChoice } = this.view.elements;
    mixedContentChoice.hidden = location.protocol !== 'https:';
    try {
      mixedContentCheckbox.checked = localStorage.getItem(SourcesPanel.MIXED_CONTENT_STORAGE_KEY) === 'yes';
    } catch {
      // Storage refused: the box starts unticked each visit.
    }
    PeerAccess.allowMixedContent(mixedContentCheckbox.checked);
    if (!mixedContentChoice.hidden && !mixedContentCheckbox.checked) this.detectMixedContent();
    mixedContentCheckbox.addEventListener('change', () => {
      PeerAccess.allowMixedContent(mixedContentCheckbox.checked);
      try {
        localStorage.setItem(SourcesPanel.MIXED_CONTENT_STORAGE_KEY, mixedContentCheckbox.checked ? 'yes' : 'no');
      } catch {
        // Not remembered; applies to this visit.
      }
      this.view.setText('peerStatus', mixedContentCheckbox.checked
        ? 'Plain-http nodes and VDF servers will be tried. If they fail, the browser may still be blocking them: check the site setting.'
        : this.describeGatheredSources());
    });
  }

  /**
   * Tries a few plain-http VDF servers and nodes in the background; if the browser lets
   * any through (its site setting allows insecure content), ticks the box for this visit,
   * so nobody has to find it. Not remembered: the setting can change between visits.
   */
  async detectMixedContent() {
    const { vdfServers = [], nodes = [] } = BundledResources.gatheredSources();
    const probes = [...vdfServers.map((entry) => entry.url), ...VdfServerClient.PUBLIC_SERVER_URLS, ...nodes.map((entry) => entry.url)]
      // IP addresses only: a browser may quietly switch a named host to https (HSTS),
      // which would answer and wrongly look like plain http getting through.
      .filter((url) => /^http:\/\/\d+\.\d+\.\d+\.\d+(:\d+)?\/?$/.test(url)).slice(0, 8).map((url) => `${url.replace(/\/$/, '')}/info`);
    if (!(await PeerAccess.detectMixedContent(probes))) return;
    const { mixedContentCheckbox } = this.view.elements;
    if (mixedContentCheckbox.checked) return;
    mixedContentCheckbox.checked = true;
    PeerAccess.allowMixedContent(true);
    this.view.setText('peerStatus', 'This browser lets the page reach plain-http nodes and VDF servers here, so they will be tried too.');
    this.view.log('plain-http requests get through from this https page (the browser allows insecure content here); nodes and VDF servers will be tried', 'info');
  }

  static SEEDS_STORAGE_KEY = 'weave-tab-miner.seeds';

  /** The typed seed list, remembered in this browser only; storage may be refused. */
  restoreSeeds() {
    try {
      this.view.elements.seedInput.value = localStorage.getItem(SourcesPanel.SEEDS_STORAGE_KEY) ?? '';
    } catch {
      // Storage refused (private window, blocked site data): the seeds simply are not remembered.
    }
    this.applySeeds();
  }

  applySeeds() {
    const seeds = SourceTester.parseList(this.view.elements.seedInput.value);
    try {
      localStorage.setItem(SourcesPanel.SEEDS_STORAGE_KEY, this.view.elements.seedInput.value);
    } catch {
      // Not remembered; still used for this visit.
    }
    this.gateway.preferFirst(seeds);
    return seeds;
  }

  // Stop once this many answer: enough to fall back on, without knocking on every host.
  static ENOUGH_WORKING_SOURCES = 8;

  /** Seeds first, then the gateways in use, then the gathered list (nodes only when reachable). */
  sourceCandidates(seeds) {
    const gathered = BundledResources.gatheredSources();
    const nodeUrls = PeerAccess.blockedReason() ? [] : gathered.nodes.map((entry) => entry.url);
    return [...new Set([...seeds, ...this.gateway.gatewayUrls, ...gathered.gateways.map((entry) => entry.url), ...nodeUrls])];
  }

  /**
   * Where to ask for VDF steps, best first: sources this page saw serve it, ones GitHub saw
   * serve it, the Arweave team's public servers, then every gateway in use. Plain-http ones
   * are dropped on an https page, which may not call them.
   */
  vdfServerCandidates() {
    const gathered = BundledResources.gatheredSources().vdfServers ?? [];
    const all = [...new Set([...(this.testedVdfServerUrls ?? []), ...gathered.map((entry) => entry.url), ...VdfServerClient.PUBLIC_SERVER_URLS, ...this.gateway.gatewayUrls])];
    if (!PeerAccess.blockedReason()) return all;
    const reachable = all.filter((url) => !url.startsWith('http:'));
    if (reachable.length < all.length) this.view.log(`skipping ${all.length - reachable.length} plain-http VDF servers: an https page may not call them; a downloaded copy can`, 'warn');
    return reachable;
  }

  describeGatheredSources() {
    const { gatheredAt, gateways, nodes } = BundledResources.gatheredSources();
    if (!gatheredAt) return '"Test all sources" tries your own sources and the 2 built-in gateways. If none answer, "Find gateways and peers" looks further, including the gateway list kept on Solana.';
    const nodeNote = PeerAccess.blockedReason() ? ' (nodes only from a downloaded copy)' : '';
    return `This copy carries ${gateways.length} gateways and ${nodes.length} nodes${nodeNote} that answered GitHub on ${gatheredAt.slice(0, 10)}. Test all sources tries them, a few at a time, until ${SourcesPanel.ENOUGH_WORKING_SOURCES} answer.`;
  }

  async testSources() {
    const seeds = this.applySeeds();
    const candidates = this.sourceCandidates(seeds);
    this.view.setText('peerStatus', `Testing up to ${candidates.length} sources…`);
    const results = await new SourceTester().testAll(candidates, {
      concurrency: 4,
      checkVdf: true,
      enoughWorking: SourcesPanel.ENOUGH_WORKING_SOURCES,
      onResult: (result, testedCount) => this.view.setText('peerStatus', `Tested ${testedCount} of ${candidates.length}…`),
    });
    const list = this.view.elements.sourceResults;
    list.replaceChildren(...results.map((result) => {
      const item = document.createElement('li');
      item.className = result.ok ? 'source-ok' : 'source-failed';
      const vdfNote = result.vdf ? ', serves VDF' : '';
      item.textContent = result.ok
        ? `✓ ${result.url} — ${result.milliseconds} ms, height ${result.height.toLocaleString()}${vdfNote}`
        : `✗ ${result.url} — ${result.error}${vdfNote}`;
      return item;
    }));
    this.testedVdfServerUrls = results.filter((result) => result.vdf).map((result) => result.url);
    const working = results.filter((result) => result.ok).map((result) => result.url);
    // Seeds that work keep their place at the front; then the fastest of the rest.
    this.gateway.preferFirst([...seeds.filter((url) => working.includes(url)), ...working]);
    this.view.setText('peerStatus', working.length
      ? `${working.length} of ${results.length} tested sources answered; they are now tried fastest first.`
      : 'Nothing answered from here. This network may block Arweave: try another network or a phone hotspot, or add a gateway you know works above. The sample block still works offline.');
    this.view.log(`source test: ${working.length} of ${results.length} answered, ${this.testedVdfServerUrls.length} served the VDF`, working.length ? 'good' : 'error');
  }

  async loadLiveBlock() {
    this.view.setText('networkStatus', 'Fetching the current block…');
    try {
      this.useBlock(await this.gateway.currentBlock(), 'live');
      return true;
    } catch (error) {
      this.view.setText('networkStatus', 'Nothing answered. The network here may block Arweave; the sample block still works.');
      this.view.log(error.message, 'error');
      return false;
    }
  }

  loadSampleBlock() {
    this.useBlock(BundledResources.sampleBlock(), 'sample');
  }

  useBlock(block, origin) {
    this.block = block;
    this.blockOrigin = origin;
    this.session = VdfSession.fromBlock(block);
    // The sample can only replay its own steps; a live block mines new ones from VDF servers.
    this.view.elements[origin === 'sample' ? 'vdfModeReplay' : 'vdfModeServer'].checked = true;
    const partitionInput = this.view.elements.partitionInput;
    // The browser's own partition unless the person chose one or chunks are held elsewhere;
    // "Verify against the sample" sets the sample's own partition for its replay.
    if (!this.partitionChosenByPerson && !this.storage?.byteCount) partitionInput.value = String(this.browserPartition());
    this.view.setText('networkHeight', this.session.height.toLocaleString());
    this.view.setText('networkStep', this.session.latestStepNumber.toLocaleString());
    const source = this.gateway.lastAnsweredBy && origin === 'live' ? ` from ${this.gateway.lastAnsweredBy}` : '';
    this.view.setText('networkStatus', `${origin === 'live' ? 'Live' : 'Sample'} block ${this.session.height}${source}; ${this.session.stepOutputsNewestFirst.length} VDF steps; weave ${PageView.formatBytes(Number(this.session.partitionUpperBound))}`);
    this.view.log(`using ${origin} block at height ${this.session.height}`);
    this.refreshSummary();
    this.refreshPoolOdds();
    this.fillStorageInBackground();
  }
}
