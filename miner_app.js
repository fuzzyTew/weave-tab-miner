// miner_app.js — the page's controller. Mining, RandomX, storage, network, wallet and
// transaction logic live in the arweave_*.js library modules; this file only wires the
// page's controls and displays to them.
import {
  Bytes, ConsensusConstants, Replica29Layout, MiningIdentity, ChunkPacker, StubEntropySource,
  StubH0Hasher, HeldStorage, Miner, VdfSession, SolutionOdds,
} from './arweave_miner.js';
import { ArweaveGateway } from './arweave_gateway.js';
import { ArweaveWallet } from './arweave_wallet.js';
import { DataTransaction } from './arweave_transaction.js';
import { DataItem, TurboUploader } from './arweave_bundle.js';
import { RandomxWorkerHost, RandomxH0Hasher, RandomxSquaredEntropySource } from './arweave_randomx.js';
import { PackedChunkStore } from './arweave_storage.js';
import { PeerAccess, PeerDirectory, GatewayDirectory, SourceTester } from './arweave_peers.js';
import { VdfServerClient, VdfUpdate } from './arweave_vdf_client.js';
import { SourceCitations } from './arweave_citations.js';

class BundledResources {
  /**
   * The sample block and the workers' source texts are embedded in the page by
   * build_single_file.mjs, so it opens from disk with no web server. Workers are made from
   * blob: URLs and run as classic scripts: Chromium refuses module workers from blob: URLs
   * on pages opened from file://.
   */
  static embeddedText(elementId) {
    const text = document.getElementById(elementId)?.textContent;
    if (!text) throw new Error(`the page is missing its embedded ${elementId}; open the built weave-tab-miner.html`);
    return text;
  }

  /**
   * Gateways and nodes that answered from GitHub's runners when the page was built
   * (gather_sources.mjs), as { gatheredAt, gateways, nodes }; an empty list when missing.
   */
  static gatheredSources() {
    try {
      return JSON.parse(BundledResources.embeddedText('sourcesData'));
    } catch {
      return { gatheredAt: null, gateways: [], nodes: [], vdfServers: [] };
    }
  }

  static sampleBlock() {
    return JSON.parse(BundledResources.embeddedText('sampleBlockData'));
  }

  static worker(elementId) {
    return new Worker(URL.createObjectURL(new Blob([BundledResources.embeddedText(elementId)], { type: 'text/javascript' })));
  }
}

class RunYourself {
  /**
   * Fills the "Run it yourself" panel: a download link when the page came from a web
   * server, and a link to its permanent Arweave copy once one exists (permaweb.json).
   */
  static GATEWAYS_FOR_LINKS = ['https://arweave.net', 'https://turbo-gateway.com'];

  constructor(view) {
    this.view = view;
  }

  show() {
    const link = this.view.elements.downloadLink;
    if (location.protocol === 'file:') {
      link.hidden = true;
      this.view.setText('downloadNote', 'You are running a copy from your own disk, which can also reach Arweave nodes directly.');
    } else {
      // Same-origin links honour the download attribute, saving the page as it was served.
      link.href = location.href.split('#')[0];
      this.view.setText('downloadNote', 'Save it and open the file from your disk: it runs with no server, keeps working if this site goes away, and can reach Arweave nodes directly.');
    }

    const { transactionId } = JSON.parse(BundledResources.embeddedText('permawebData'));
    const list = this.view.elements.permawebLinks;
    list.replaceChildren();
    if (!transactionId) {
      this.view.setText('permawebNote', 'Not stored on Arweave yet. Storing this page (about 1 MB) costs a small amount of AR, paid once; whoever pays can put the transaction id in permaweb.json, and the next build links to it here, from any gateway.');
      return;
    }
    this.view.setText('permawebNote', `Stored permanently on Arweave as transaction ${transactionId}. Any gateway serves the same bytes:`);
    for (const gateway of RunYourself.GATEWAYS_FOR_LINKS) {
      const item = document.createElement('li');
      const anchor = document.createElement('a');
      anchor.href = `${gateway}/${transactionId}`;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.textContent = anchor.href;
      item.append(anchor);
      list.append(item);
    }
  }
}

class PageView {
  /**
   * Thin helpers over the page's elements, so the controller reads as what it shows.
   */
  constructor() {
    this.elements = new Proxy({}, { get: (_, id) => document.getElementById(id) });
  }

  setText(id, text) {
    this.elements[id].textContent = text;
  }

  log(message, tone = 'info') {
    const line = document.createElement('li');
    line.className = `log-line tone-${tone}`;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    line.textContent = `${time}  ${message}`;
    const list = this.elements.activityLog;
    list.prepend(line);
    while (list.children.length > 200) list.lastChild.remove();
  }

  static shortHex(bytes, length = 12) {
    return Bytes.toHex(bytes).slice(0, length) + '…';
  }

  static formatBytes(count) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let value = count;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  static formatDuration(seconds) {
    if (!isFinite(seconds)) return 'never (no data held)';
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)} minutes`;
    if (seconds < 86_400 * 2) return `${(seconds / 3600).toFixed(1)} hours`;
    const years = seconds / 31_557_600;
    if (years < 1) return `${(seconds / 86_400).toFixed(1)} days`;
    return years < 1e6 ? `${Math.round(years).toLocaleString()} years` : `${years.toExponential(2).replace('e+', ' × 10^')} years`;
  }

  static formatAr(winston) {
    const whole = winston / 1_000_000_000_000n;
    const fraction = (winston % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
    return `${whole}${fraction ? '.' + fraction : ''} AR`;
  }

  addStepRow(report, source, onSelect) {
    const row = document.createElement('tr');
    const result = report.solution ? `found: ${report.solution.kind}` : report.noncesTried ? 'no pass' : 'no data held in range';
    const cells = [
      report.stepNumber.toLocaleString(), source, PageView.shortHex(report.h0, 10),
      report.range1Start.toLocaleString(), report.range2Start.toLocaleString(),
      String(report.noncesTried), String(report.h2Tried), result,
    ];
    for (const text of cells) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    row.tabIndex = 0;
    row.title = 'Show this step in the explorer';
    row.addEventListener('click', onSelect);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter') onSelect(); });
    if (report.solution) row.className = 'row-solution';
    const body = this.elements.stepRows;
    body.prepend(row);
    while (body.children.length > 60) body.lastChild.remove();
  }

  fillHistory(listId, transactions, emptyText) {
    const list = this.elements[listId];
    list.replaceChildren();
    if (transactions.length === 0) {
      const item = document.createElement('li');
      item.textContent = emptyText;
      list.append(item);
      return;
    }
    for (const transaction of transactions) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `https://viewblock.io/arweave/tx/${transaction.id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = transaction.id.slice(0, 12) + '…';
      const height = transaction.block ? `block ${transaction.block.height}` : 'pending';
      const amount = Number(transaction.quantity.ar) > 0 ? `${transaction.quantity.ar} AR` : `${PageView.formatBytes(Number(transaction.data.size))} data`;
      item.append(link, ` · ${amount} · ${height}`);
      list.append(item);
    }
  }

  fillLimits(factors) {
    const list = this.elements.limitList;
    list.replaceChildren();
    for (const factor of factors) {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = factor.name;
      item.append(name, ` — ${factor.explanation}`);
      if (factor.speedup <= 1.0001) item.className = 'limit-met';
      list.append(item);
    }
  }
}

class StepExplorer {
  /**
   * Shows one mining step's intermediate values, each with a link to the node source rule
   * that produces it, so a person can redo the step by hand.
   */
  constructor(view) {
    this.view = view;
  }

  static row(label, value, ruleName) {
    const row = document.createElement('tr');
    const labelCell = document.createElement('th');
    labelCell.scope = 'row';
    labelCell.textContent = label;
    const valueCell = document.createElement('td');
    valueCell.className = 'explorer-value';
    valueCell.textContent = value;
    const sourceCell = document.createElement('td');
    if (ruleName) {
      const link = document.createElement('a');
      link.href = SourceCitations.url(ruleName);
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = SourceCitations.label(ruleName);
      link.title = SourceCitations.RULES[ruleName].what;
      sourceCell.append(link);
    }
    row.append(labelCell, valueCell, sourceCell);
    return row;
  }

  show(report) {
    const trace = report.trace;
    const hex = (bytes) => Bytes.toHex(bytes);
    const rows = [
      ['VDF output, step ' + report.stepNumber.toLocaleString(), hex(trace.vdfOutput), 'vdfStep'],
      ['Partition number', String(trace.partitionNumber), 'h0'],
      ['Seed (first 32 bytes)', hex(trace.seed), 'h0Seed'],
      ['Mining address', hex(trace.address), 'h0'],
      ['Packing difficulty', String(trace.packingDifficulty), 'h0'],
      ['H0 preimage', hex(trace.h0Preimage), 'h0'],
      [trace.h0IsStub ? 'H0 (SHA-256 stand-in)' : 'H0 = RandomX(preimage)', hex(trace.h0), trace.h0IsStub ? null : 'h0RandomxState'],
      ['Recall range 1 start', trace.range1Start.toLocaleString(), 'recallRange'],
      ['Recall range 2 start', trace.range2Start.toLocaleString(), 'recallRange'],
      ['Nonces per range', `${ConsensusConstants.noncesPerRecallRange} (${ConsensusConstants.recallRangeSize.toLocaleString()} bytes ÷ 8 KiB)`, 'recallRangeSize'],
    ];
    const tried = trace.firstHeldNonce;
    if (tried) {
      rows.push(
        ['First nonce on held data', String(tried.nonce), 'recallByte'],
        ['→ recall byte 1, sub-chunk', `${tried.recallByte1.toLocaleString()}, sub-chunk ${tried.subChunkIndex}`, 'recallByte'],
        ['H1 preimage', hex(tried.h1.preimage), 'h1'],
        ['H1', hex(tried.h1.hash), 'h1'],
        ['→ recall byte 2', `${tried.recallByte2.toLocaleString()}${tried.h2 ? '' : ' (not held, so no H2)'}`, 'recallByte'],
      );
      if (tried.h2) rows.push(['H2 preimage', hex(tried.h2.preimage), 'h2'], ['H2', hex(tried.h2.hash), 'solutionHash']);
    } else {
      rows.push(['Nonces on held data', 'none this step: neither recall range touched a held chunk', 'recallRange']);
    }
    rows.push(['Pass rule', 'hash, as a big-endian number, must exceed the scaled difficulty', 'diffCheck']);
    if (report.solution) rows.push(['Result', `${report.solution.kind} at nonce ${report.solution.nonce}: ${hex(report.solution.hash)}`, 'diffCheck']);

    const body = this.view.elements.explorerRows;
    body.replaceChildren(...rows.map(([label, value, rule]) => StepExplorer.row(label, value, rule)));
    this.view.setText('explorerTitle', `Step ${report.stepNumber.toLocaleString()}`);
  }
}

class StepPace {
  /**
   * Measures how many VDF steps a second actually reach the miner, over the last minute.
   */
  constructor() {
    this.arrivals = [];
  }

  record() {
    const now = performance.now();
    this.arrivals.push(now);
    while (this.arrivals.length && now - this.arrivals[0] > 60_000) this.arrivals.shift();
  }

  reset() {
    this.arrivals = [];
  }

  stepsPerSecond(fallback) {
    if (this.arrivals.length < 3) return fallback;
    const spanSeconds = (this.arrivals.at(-1) - this.arrivals[0]) / 1000;
    return spanSeconds > 0 ? (this.arrivals.length - 1) / spanSeconds : fallback;
  }
}

class BrowserNodeApp {
  /**
   * The in-browser node: picks an identity, holds packed chunks (kept in browser storage),
   * follows the VDF and mines each step with real RandomX; it can also look up a wallet
   * and send a data transaction. Keys live in memory only.
   */
  static REPLAY_STEP_INTERVAL_MS = 1000; // the network's VDF pace, about one step per second

  constructor() {
    this.view = new PageView();
    this.explorer = new StepExplorer(this.view);
    this.gateway = new ArweaveGateway({ log: (message) => this.view.log(message, 'warn') });
    this.store = new PackedChunkStore({ log: (message) => this.view.log(message, 'warn') });
    this.pace = new StepPace();
    this.identity = null;
    this.session = null;
    this.storage = new HeldStorage();
    this.h0Hasher = new StubH0Hasher();
    this.entropySource = new StubEntropySource();
    this.randomxReady = this.startRandomx();
    this.running = false;
    this.stepsMined = 0;
    this.lastMinedStep = -1;
    this.vdfWorker = null;
    this.peerUrls = [];
  }

  // ---- RandomX ----

  async startRandomx() {
    this.view.setText('randomxStatus', 'building the 512 MiB cache…');
    try {
      const host = new RandomxWorkerHost(() => BundledResources.worker('randomxWorkerSource'));
      await host.ready();
      this.h0Hasher = new RandomxH0Hasher(host);
      this.entropySource = new RandomxSquaredEntropySource(host);
      this.view.setText('randomxStatus', 'real (Arweave\'s RandomX in WebAssembly)');
      this.view.log('RandomX ready: H0 and packing are real', 'good');
      return true;
    } catch (error) {
      this.view.setText('randomxStatus', 'unavailable: using SHA-256 stand-ins');
      this.view.log(`RandomX unavailable, so H0 and packing fall back to stand-ins that find nothing real: ${error.message}`, 'error');
      return false;
    }
  }

  get usingRealRandomx() {
    return !this.h0Hasher.isStub;
  }

  // ---- identity ----

  async generateIdentity() {
    this.view.setText('identityStatus', 'Generating a 4096-bit key…');
    await this.setIdentity(MiningIdentity.fromWallet(await ArweaveWallet.generate()), 'new key made in this tab and never saved; it can sign transactions');
  }

  async useAddress() {
    try {
      await this.setIdentity(MiningIdentity.fromAddress(this.view.elements.addressInput.value), 'address only: enough to mine and look up, not to sign');
    } catch (error) {
      this.view.setText('identityStatus', `That address did not work: ${error.message}. It should be 43 characters.`);
    }
  }

  async loadKeyfile() {
    try {
      const wallet = await ArweaveWallet.fromJwk(JSON.parse(this.view.elements.keyfileInput.value));
      this.view.elements.keyfileInput.value = '';
      await this.setIdentity(MiningIdentity.fromWallet(wallet), 'keyfile loaded into this tab only; it can sign transactions');
    } catch (error) {
      this.view.setText('identityStatus', `That keyfile did not load: ${error.message}`);
    }
  }

  async copyKeyfile() {
    if (!this.identity?.wallet) {
      this.view.setText('identityStatus', 'Only a generated or loaded key has a keyfile to copy.');
      return;
    }
    const text = JSON.stringify(await this.identity.wallet.exportJwk());
    try {
      await navigator.clipboard.writeText(text);
      this.view.setText('identityStatus', 'Keyfile copied. Anyone holding it controls this address.');
    } catch {
      this.view.elements.keyfileInput.value = text;
      this.view.elements.keyfileInput.select();
      this.view.setText('identityStatus', 'Copying was blocked, so the keyfile is in the box above, selected. Anyone holding it controls this address.');
    }
  }

  async setIdentity(identity, note) {
    this.identity = identity;
    this.storage = new HeldStorage(); // packing is per address, so another address's chunks do not count
    this.view.setText('identityAddress', identity.address);
    this.view.setText('identityStatus', note);
    this.view.elements.walletAddressInput.value = identity.address;
    this.view.setText('holdStatus', 'No data held for this address yet.');
    this.view.log(`identity set: ${identity.address}`);
    await this.restoreStoredChunks();
    this.refreshSummary();
  }

  // ---- browser storage ----

  async restoreStoredChunks() {
    // Stand-in packing is never saved, so anything stored is real packing.
    const entries = await this.store.load(this.identity.address);
    for (const [bucketEndOffset, packedChunk] of entries) this.storage.add(bucketEndOffset, packedChunk);
    if (entries.length) {
      this.view.log(`restored ${entries.length} packed chunk${entries.length === 1 ? '' : 's'} from browser storage`, 'good');
      this.view.setText('holdStatus', `Holding ${entries.length} packed chunk${entries.length === 1 ? '' : 's'} saved in this browser earlier.`);
    }
    await this.refreshStorageNote();
  }

  async saveChunks(entries) {
    if (!this.usingRealRandomx) return;
    if (await this.store.save(this.identity.address, entries)) {
      const persistent = await PackedChunkStore.requestPersistence();
      this.view.log(`saved ${entries.length} packed chunk${entries.length === 1 ? '' : 's'} to browser storage${persistent ? '' : ' (the browser may clear it if disk runs low)'}`);
    }
    await this.refreshStorageNote();
  }

  async refreshStorageNote() {
    const estimate = await PackedChunkStore.estimate();
    this.view.setText('storageNote', estimate
      ? `This site uses ${PageView.formatBytes(estimate.usage ?? 0)} of browser storage, of ${PageView.formatBytes(estimate.quota ?? 0)} allowed.`
      : 'This browser does not report its storage limits.');
  }

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

  static SEEDS_STORAGE_KEY = 'weave-tab-miner.seeds';

  /** The typed seed list, remembered in this browser only; storage may be refused. */
  restoreSeeds() {
    try {
      this.view.elements.seedInput.value = localStorage.getItem(BrowserNodeApp.SEEDS_STORAGE_KEY) ?? '';
    } catch {
      // Storage refused (private window, blocked site data): the seeds simply are not remembered.
    }
    this.applySeeds();
  }

  applySeeds() {
    const seeds = SourceTester.parseList(this.view.elements.seedInput.value);
    try {
      localStorage.setItem(BrowserNodeApp.SEEDS_STORAGE_KEY, this.view.elements.seedInput.value);
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
    if (!gatheredAt) return 'This copy has no gathered list; Test all sources tries your own and the 2 built in. If ar.io gateways are blocked, Find gateways reads their registry from Solana.';
    const nodeNote = PeerAccess.blockedReason() ? ' (nodes only from a downloaded copy)' : '';
    return `This copy carries ${gateways.length} gateways and ${nodes.length} nodes${nodeNote} that answered GitHub on ${gatheredAt.slice(0, 10)}. Test all sources tries them, a few at a time, until ${BrowserNodeApp.ENOUGH_WORKING_SOURCES} answer.`;
  }

  async testSources() {
    const seeds = this.applySeeds();
    const candidates = this.sourceCandidates(seeds);
    this.view.setText('peerStatus', `Testing up to ${candidates.length} sources…`);
    const results = await new SourceTester().testAll(candidates, {
      concurrency: 4,
      checkVdf: true,
      enoughWorking: BrowserNodeApp.ENOUGH_WORKING_SOURCES,
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
    const partitionInput = this.view.elements.partitionInput;
    if (!partitionInput.value) partitionInput.value = String(block.partition_number ?? 0);
    this.view.setText('networkHeight', this.session.height.toLocaleString());
    this.view.setText('networkStep', this.session.latestStepNumber.toLocaleString());
    const source = this.gateway.lastAnsweredBy && origin === 'live' ? ` from ${this.gateway.lastAnsweredBy}` : '';
    this.view.setText('networkStatus', `${origin === 'live' ? 'Live' : 'Sample'} block ${this.session.height}${source}; ${this.session.stepOutputsNewestFirst.length} VDF steps; weave ${PageView.formatBytes(Number(this.session.partitionUpperBound))}`);
    this.view.log(`using ${origin} block at height ${this.session.height}`);
    this.refreshSummary();
    this.refreshPoolOdds();
  }

  // ---- holding data ----

  get partitionNumber() {
    return Number(this.view.elements.partitionInput.value || 0);
  }

  packingProgress(done, total) {
    this.view.setText('holdStatus', `Packing: entropy ${done} of ${total} (about a second each)…`);
  }

  async holdChunks() {
    if (!this.identity || !this.session) {
      this.view.log('pick an identity and load a block first', 'warn');
      return;
    }
    await this.randomxReady;
    if (this.blockOrigin === 'sample') await this.holdSampleChunks();
    else await this.holdLiveChunks();
    this.refreshSummary();
  }

  async holdSampleChunks() {
    const proofs = [['poa', 'recall_byte'], ['poa2', 'recall_byte2']];
    if (this.identity.address === this.block.reward_addr) {
      // The block carries the packed sub-chunk its own miner used, for its own address:
      // real packed data with no packing work, though only that one sub-chunk of each chunk.
      const subChunkIndex = Number(Bytes.toBigInt(Bytes.fromBase64Url(this.block.nonce))) % ConsensusConstants.SUB_CHUNK_COUNT;
      for (const [proof, byteField] of proofs) {
        const packedChunk = new Uint8Array(ConsensusConstants.DATA_CHUNK_SIZE);
        packedChunk.set(Bytes.fromBase64Url(this.block[proof].chunk), subChunkIndex * ConsensusConstants.SUB_CHUNK_SIZE);
        this.storage.add(Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField])), packedChunk);
      }
      this.view.setText('holdStatus', `Holding the block's own packed sub-chunk ${subChunkIndex} of each recall chunk, exactly as its miner held them.`);
      return;
    }
    // The sample has two chunks; "Chunks to fetch" can limit packing to the first.
    const wanted = Math.max(1, Math.min(proofs.length, Number(this.view.elements.chunkCountInput.value || proofs.length)));
    const chunks = proofs.slice(0, wanted).map(([proof, byteField]) => ({
      bytes: Bytes.fromBase64Url(this.block[proof].unpacked_chunk),
      endOffset: Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField])),
    }));
    await this.packAndHold(chunks);
  }

  async holdLiveChunks() {
    const wanted = Number(this.view.elements.chunkCountInput.value || 4);
    const partitionStart = BigInt(this.partitionNumber) * ConsensusConstants.PARTITION_SIZE;
    if (partitionStart >= this.session.partitionUpperBound) {
      this.view.log(`partition ${this.partitionNumber} is past the end of the weave`, 'error');
      return;
    }
    // Chunks at one bucket position in successive sectors share all 32 entropies.
    const firstByte = partitionStart + BigInt(Math.floor(Math.random() * Number(ConsensusConstants.entropySectorSize)));
    const chunks = [];
    // Twice as many positions as wanted, so chunks no source has can be skipped.
    let skipped = 0;
    for (const weaveByte of Replica29Layout.entropySharingBytes(firstByte, wanted * 2, this.session.partitionUpperBound)) {
      if (chunks.length >= wanted) break;
      this.view.setText('holdStatus', `Fetching chunk ${chunks.length + 1} of ${wanted} (byte ${weaveByte.toLocaleString()})${skipped ? `; skipped ${skipped} that no source had` : ''}…`);
      try {
        // Approximation: the chunk is filed under the 256 KiB bucket holding the byte asked
        // for. Exact would place it by its own end offset from its data_path.
        chunks.push({ bytes: Bytes.fromBase64Url((await this.gateway.chunkJson(weaveByte)).chunk), endOffset: Replica29Layout.bucketEndOffsetForByte(weaveByte) });
      } catch (error) {
        skipped++;
        this.view.log(`skipping the chunk at byte ${weaveByte}: no source had it (${error.message.split('\n')[1] ?? error.message})`, 'warn');
      }
    }
    if (chunks.length) await this.packAndHold(chunks);
    else this.view.setText('holdStatus', 'No chunks could be fetched.');
  }

  async packAndHold(chunks) {
    const started = performance.now();
    const packer = new ChunkPacker(this.identity, this.entropySource);
    const packed = await packer.packChunks(chunks, (done, total) => this.packingProgress(done, total));
    const entries = packed.map((packedChunk, index) => [chunks[index].endOffset, packedChunk]);
    for (const [endOffset, packedChunk] of entries) this.storage.add(endOffset, packedChunk);
    const seconds = (performance.now() - started) / 1000;
    this.view.setText('holdStatus', `Packed ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} in ${seconds.toFixed(0)} s${this.usingRealRandomx ? '' : ' with stand-in packing, which is not saved'}.`);
    this.view.log(`packed ${chunks.length} chunks for ${this.identity.address.slice(0, 8)}…`, 'good');
    await this.saveChunks(entries);
  }

  // ---- mining ----

  get isTestMode() {
    return this.view.elements.aimCheckbox.checked || Number(this.view.elements.easeSelect.value) !== 1;
  }

  makeMiner() {
    return new Miner({
      identity: this.identity, partitionNumber: this.partitionNumber, storage: this.storage, h0Hasher: this.h0Hasher,
      testMode: { aimRange1AtHeldData: this.view.elements.aimCheckbox.checked, difficultyEase: Number(this.view.elements.easeSelect.value) },
    });
  }

  async mineOne(stepNumber, output, source) {
    const report = await this.makeMiner().mineStep(this.session, stepNumber, output);
    this.stepsMined++;
    this.pace.record();
    this.lastMinedStep = Math.max(this.lastMinedStep, stepNumber);
    this.view.setText('stepsMined', this.stepsMined.toLocaleString());
    this.view.addStepRow(report, source, () => this.explorer.show(report));
    if (report.noncesTried || !this.explorerShown) {
      this.explorer.show(report);
      this.explorerShown = true;
    }
    this.refreshSummary();
    if (report.solution) this.announceSolution(report, source);
  }

  announceSolution(report, source) {
    const isSampleReplay = this.blockOrigin === 'sample' && source === 'block' && Bytes.equal(report.solution.hash, Bytes.fromBase64Url(this.block.hash));
    let title = 'Solution found!';
    let detail;
    if (this.isTestMode) {
      title = 'Solution found! (test mode)';
      detail = 'Test mode eased the rules, so the network would reject this.';
    } else if (!this.usingRealRandomx) {
      detail = 'RandomX is not available here, so H0 and packing are stand-ins and the network would reject it.';
    } else if (isSampleReplay) {
      detail = `This is block ${this.session.height.toLocaleString()}'s own solution, found again from scratch with real RandomX: the same hash its miner found. It is already on chain, so it earns nothing now.`;
    } else {
      detail = 'Real rules throughout. Turning this into a block also needs a signed block built around it, which this page does not do yet.';
    }
    this.view.elements.solutionBanner.hidden = false;
    this.view.setText('solutionTitle', title);
    this.view.setText('solutionDetail', `${report.solution.kind} at step ${report.stepNumber.toLocaleString()}, nonce ${report.solution.nonce}, hash ${PageView.shortHex(report.solution.hash, 24)}. ${detail}`);
    this.view.log(`solution found at step ${report.stepNumber}`, 'good');
    this.explorer.show(report);
    this.stop();
  }

  async start() {
    if (!this.identity || !this.session) {
      this.view.log('pick an identity and load a block first', 'warn');
      return;
    }
    await this.randomxReady;
    this.running = true;
    this.pace.reset();
    this.view.elements.solutionBanner.hidden = true;
    this.view.elements.startButton.disabled = true;
    this.view.elements.stopButton.disabled = false;
    if (this.view.elements.vdfModeLocal.checked) this.runLocalVdf();
    else if (this.view.elements.vdfModeServer.checked) this.runVdfServer();
    else this.runReplay();
  }

  stop() {
    this.running = false;
    clearTimeout(this.replayTimer);
    clearTimeout(this.serverTimer);
    this.view.elements.startButton.disabled = false;
    this.view.elements.stopButton.disabled = true;
  }

  /** The block's last REPLAY_STEP_COUNT steps, ending on the step it was mined at, one a second. */
  static REPLAY_STEP_COUNT = 15;

  runReplay() {
    const steps = this.session.steps().slice(-BrowserNodeApp.REPLAY_STEP_COUNT);
    let index = 0;
    const next = async () => {
      if (!this.running) return;
      if (index >= steps.length) {
        this.view.log('replayed every step in this block; choose another VDF source to keep going', 'warn');
        this.stop();
        return;
      }
      const [stepNumber, output] = steps[index++];
      await this.mineOne(stepNumber, output, 'block');
      if (this.running) this.replayTimer = setTimeout(next, BrowserNodeApp.REPLAY_STEP_INTERVAL_MS);
    };
    next();
  }

  /**
   * Steps from a public VDF server: the only way to keep the network's pace without
   * computing the VDF here. Falls back to telling the person when none answers.
   */
  async runVdfServer() {
    const candidates = this.vdfServerCandidates();
    this.view.setText('vdfStatus', `Looking for a VDF server among ${candidates.length} candidates…`);
    const client = new VdfServerClient({ baseUrls: candidates, log: (message) => this.view.log(message, 'warn') });
    if (!(await client.findServer())) {
      const downloadHint = PeerAccess.blockedReason() ? ' The public VDF servers use plain http, which a downloaded copy opened from disk can reach.' : '';
      this.view.setText('vdfStatus', `No VDF server answered this page.${downloadHint} "Compute VDF steps in this tab" works without one, but uses a whole CPU core.`);
      this.stop();
      return;
    }
    this.view.setText('vdfStatus', `Getting VDF steps from ${client.serverUrl}.`);
    const poll = async () => {
      if (!this.running) return;
      try {
        const update = await client.latest();
        for (const [stepNumber, output] of VdfUpdate.steps(update, this.lastMinedStep)) {
          if (!this.running) return;
          await this.mineOne(stepNumber, output, 'VDF server');
        }
      } catch (error) {
        this.view.log(`VDF server: ${error.message}`, 'warn');
      }
      if (this.running) this.serverTimer = setTimeout(poll, VdfServerClient.POLL_INTERVAL_MS);
    };
    poll();
  }

  runLocalVdf() {
    if (!this.vdfWorker) {
      this.vdfWorker = BundledResources.worker('vdfWorkerSource');
      this.vdfWorker.onerror = (event) => {
        this.view.log(`VDF worker could not run: ${event.message || 'the browser gave no reason'}`, 'error');
        this.stop();
      };
    }
    let stepNumber = this.localStepNumber ?? this.session.latestStepNumber;
    let previousOutput = this.localOutput ?? this.session.stepOutputsNewestFirst[0];
    let lastStepSeconds = null;
    const requestNext = () => {
      if (!this.running) return;
      const pace = lastStepSeconds === null ? '' : ` The last took ${lastStepSeconds.toFixed(1)} s here; the network does one per second.`;
      this.view.setText('vdfStatus', `Computing step ${(stepNumber + 1).toLocaleString()}…${pace}`);
      // Assumption: on reset steps the session's next_seed is mixed in (ar_nonce_limiter:maybe_add_entropy).
      this.vdfWorker.postMessage({ stepNumber: stepNumber + 1, previousOutput, iterationsPerCheckpoint: this.session.vdfDifficulty, resetSeed: this.session.nextSeed });
    };
    this.vdfWorker.onmessage = async ({ data }) => {
      if (data.error) {
        this.view.log(`VDF worker failed: ${data.error}`, 'error');
        this.stop();
        return;
      }
      stepNumber = data.stepNumber;
      previousOutput = data.output;
      this.localStepNumber = stepNumber;
      this.localOutput = previousOutput;
      lastStepSeconds = data.seconds;
      requestNext(); // start the next step while this one is mined
      if (this.running) await this.mineOne(stepNumber, previousOutput, 'this tab');
    };
    requestNext();
  }

  // ---- wallet lookup ----

  async lookUpWallet() {
    const address = this.view.elements.walletAddressInput.value.trim();
    this.view.setText('walletStatus', `Looking up ${address.slice(0, 8)}…`);
    try {
      const [balance, reserved, history] = await Promise.allSettled([
        this.gateway.balanceWinston(address), this.gateway.reservedRewardsWinston(address), this.gateway.transactionHistory(address),
      ]);
      this.view.setText('walletBalance', balance.status === 'fulfilled' ? PageView.formatAr(balance.value) : 'unavailable');
      this.view.setText('walletReserved', reserved.status === 'fulfilled' ? PageView.formatAr(reserved.value) : 'unavailable from these gateways');
      if (history.status === 'fulfilled') {
        this.view.fillHistory('walletSent', history.value.sent, 'nothing sent');
        this.view.fillHistory('walletReceived', history.value.received, 'nothing received');
      }
      const failed = [balance, reserved, history].filter((result) => result.status === 'rejected');
      for (const result of failed) this.view.log(result.reason.message.split('\n')[0], 'error');
      this.view.setText('walletStatus', failed.length === 3 ? 'Nothing answered.' : `Checked at ${new Date().toLocaleTimeString()}.`);
    } catch (error) {
      this.view.setText('walletStatus', `Lookup failed: ${error.message}`);
    }
  }

  // ---- storing a record ----

  recordBytes() {
    return new TextEncoder().encode(this.view.elements.recordInput.value);
  }

  async quoteRecord() {
    const byteCount = this.recordBytes().length;
    try {
      const winston = await this.gateway.priceWinston(byteCount);
      this.view.setText('recordStatus', `${byteCount} bytes would cost ${PageView.formatAr(winston)} right now.`);
      return winston;
    } catch (error) {
      this.view.setText('recordStatus', 'Could not get a price; nothing answered.');
      this.view.log(error.message.split('\n')[0], 'error');
      return null;
    }
  }

  async sendRecord() {
    const wallet = this.identity?.wallet;
    if (!wallet) {
      this.view.setText('recordStatus', 'Sending needs a key: generate one or load a keyfile in Identity. An address alone cannot sign.');
      return;
    }
    const rewardWinston = await this.quoteRecord();
    if (rewardWinston === null) return;
    try {
      const anchor = await this.gateway.transactionAnchor();
      const transaction = await new DataTransaction({
        data: this.recordBytes(), anchor, rewardWinston,
        tags: [['Content-Type', 'text/plain; charset=utf-8'], ['App-Name', 'Weave-Tab-Miner']],
      }).sign(wallet);
      this.view.setText('recordStatus', `Signed ${transaction.id}. Sending…`);
      const reply = await this.gateway.postTransaction(transaction.toJson());
      this.view.setText('recordStatus', `Sent to ${this.gateway.lastAnsweredBy}, which replied "${reply.slice(0, 80)}". It should be readable at arweave.net/${transaction.id} within minutes.`);
      this.view.elements.recordLink.href = `https://arweave.net/${transaction.id}`;
      this.view.elements.recordLink.textContent = `arweave.net/${transaction.id}`;
      this.view.log(`record transaction ${transaction.id} sent`, 'good');
    } catch (error) {
      const lacksFunds = /balance|funds|insufficient/i.test(error.message);
      this.view.setText('recordStatus', lacksFunds ? 'Refused: this key has no AR to pay the fee yet.' : `Not sent: ${error.message.split('\n')[0]}`);
      this.view.log(error.message.split('\n')[0], 'error');
    }
  }

  /**
   * The record as an ANS-104 item signed by this key, handed to Turbo's free tier. The id
   * is fixed by the signature here, so it can be looked up on any gateway once bundled.
   */
  async sendRecordFree() {
    const wallet = this.identity?.wallet;
    if (!wallet) {
      this.view.setText('recordStatus', 'Storing needs a key to sign with: generate one or load a keyfile in Identity. It needs no AR.');
      return;
    }
    const data = this.recordBytes();
    if (data.length > TurboUploader.FREE_BYTES - 2048) {
      this.view.setText('recordStatus', `${data.length} bytes is too big for Turbo's free tier (100 KiB including about 1 KiB of signature and tags).`);
      return;
    }
    try {
      const item = await new DataItem({ data, tags: [['Content-Type', 'text/plain; charset=utf-8'], ['App-Name', 'Weave-Tab-Miner']] }).sign(wallet);
      this.view.setText('recordStatus', `Signed item ${item.id}. Sending to Turbo…`);
      const receipt = await new TurboUploader().upload(item);
      if (receipt.id !== item.id) throw new Error(`Turbo answered for a different id, ${receipt.id}`);
      this.view.setText('recordStatus', `Turbo accepted ${item.id}${receipt.winc === '0' ? ' for free' : ` and charged ${receipt.winc} winc`}. It should be readable at arweave.net/${item.id} soon, and in a block once Turbo bundles it.`);
      this.view.elements.recordLink.href = `https://arweave.net/${item.id}`;
      this.view.elements.recordLink.textContent = `arweave.net/${item.id}`;
      this.view.log(`Turbo receipt: ${JSON.stringify(receipt).slice(0, 400)}`, 'good');
    } catch (error) {
      this.view.setText('recordStatus', `Not stored: ${error.message.split('\n')[0]}`);
      this.view.log(error.message.split('\n')[0], 'error');
    }
  }

  // ---- odds ----

  refreshSummary() {
    this.view.setText('heldBytes', PageView.formatBytes(this.storage.byteCount));
    this.view.setText('heldChunks', `${this.storage.packedChunks.size} chunk${this.storage.packedChunks.size === 1 ? '' : 's'}`);
    if (!this.session) return;
    const stepsPerSecond = this.running ? this.pace.stepsPerSecond(SolutionOdds.NETWORK_STEPS_PER_SECOND) : SolutionOdds.NETWORK_STEPS_PER_SECOND;
    const odds = { storage: this.storage, partitionNumber: this.partitionNumber, session: this.session, stepsPerSecond };
    const seconds = SolutionOdds.expectedSecondsPerSolution(odds);
    this.view.setText('expectedWait', PageView.formatDuration(seconds));
    const factors = SolutionOdds.limitingFactors(odds);
    this.view.setText('limitHeadline', `Biggest limit: ${factors[0].name}. ${this.running ? `Measured pace: ${stepsPerSecond.toFixed(2)} steps a second.` : 'Assumes the network\'s pace of one step a second until mining starts.'}`);
    this.view.fillLimits(factors);
    this.view.setText('waitNote', this.usingRealRandomx ? 'Real rules: a solution here would be a real one.' : 'Stand-in RandomX: solutions would not be real.');
  }

  refreshPoolOdds() {
    if (!this.session) return;
    const tabCount = Math.max(1, Number(this.view.elements.poolTabsInput.value || 1));
    const gibPerTab = Math.max(0, Number(this.view.elements.poolSizeInput.value || 0));
    const storedBytes = tabCount * gibPerTab * 2 ** 30;
    const { secondsPerBlock, arPerDay } = SolutionOdds.forPooledStorage({ storedBytes, session: this.session });
    this.view.setText('poolStored', `${PageView.formatBytes(storedBytes)} (${(storedBytes / Number(this.session.partitionUpperBound) * 100).toFixed(2)}% of the weave)`);
    this.view.setText('poolWait', PageView.formatDuration(secondsPerBlock));
    this.view.setText('poolEarnings', `${arPerDay.toPrecision(3)} AR a day in all; ${(arPerDay / tabCount).toPrecision(3)} AR per tab`);
    const days = SolutionOdds.daysToPayout({
      memberArPerDay: arPerDay / tabCount,
      feeFraction: Number(this.view.elements.poolFeeInput.value || 0) / 100,
      thresholdAr: Number(this.view.elements.poolThresholdInput.value || 0),
    });
    this.view.setText('poolPayout', `after about ${PageView.formatDuration(days * 86_400)} of holding ${gibPerTab} GiB`);
  }

  bind() {
    const onClick = (id, handler) => this.view.elements[id].addEventListener('click', () => handler.call(this));
    onClick('generateButton', this.generateIdentity);
    onClick('addressButton', this.useAddress);
    onClick('keyfileButton', this.loadKeyfile);
    onClick('copyKeyfileButton', this.copyKeyfile);
    onClick('peersButton', this.findPeers);
    onClick('testSourcesButton', this.testSources);
    this.view.elements.seedInput.addEventListener('change', () => this.applySeeds());
    onClick('liveButton', this.loadLiveBlock);
    onClick('sampleButton', this.loadSampleBlock);
    onClick('holdButton', this.holdChunks);
    onClick('startButton', this.start);
    onClick('stopButton', this.stop);
    onClick('walletButton', this.lookUpWallet);
    onClick('quoteButton', this.quoteRecord);
    onClick('sendButton', this.sendRecord);
    onClick('freeSendButton', this.sendRecordFree);
    this.view.elements.partitionInput.addEventListener('change', () => this.refreshSummary());
    for (const id of ['poolTabsInput', 'poolSizeInput', 'poolFeeInput', 'poolThresholdInput']) this.view.elements[id].addEventListener('input', () => this.refreshPoolOdds());
    this.view.elements.recordInput.addEventListener('input', () => this.view.setText('recordSize', `${this.recordBytes().length} bytes`));
  }

  async run() {
    this.bind();
    new RunYourself(this.view).show();
    this.restoreSeeds();
    this.view.setText('peerStatus', this.describeGatheredSources());
    // Open in a working state: the sample block, mining for the address that won it.
    this.loadSampleBlock();
    this.view.elements.addressInput.value = this.block.reward_addr;
    await this.useAddress();
    this.view.setText('identityStatus', 'Default: the address that mined the sample block, possibly a pool. Anything found would pay it, not you.');
    await this.holdChunks();
    this.view.log('ready: sample block loaded with its own packed data. Press Start mining to replay its steps.');
  }
}

new BrowserNodeApp().run();
