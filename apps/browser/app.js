// apps/browser/app.js — the page's controller: startup, identity, RandomX and wiring the
// page's controls. Mining, storage, network and wallet logic live in the library under
// src/. Each section of the page has a panel module beside this one:
//   sources-panel.js  gateways, nodes, VDF servers     holding-panel.js  packed data
//   mining-panel.js   mining and the expected wait     records-panel.js  wallet and records
//   quick-start-panel.js  the one-button start         page-view.js, step-explorer.js,
//   resources.js          display helpers and embedded data
import { Bytes } from '../../src/core/bytes.js';
import { StubEntropySource } from '../../src/mining/packing.js';
import { MiningIdentity } from '../../src/mining/identity.js';
import { StubH0Hasher } from '../../src/mining/mining-math.js';
import { HeldStorage } from '../../src/mining/held-storage.js';
import { ArweaveGateway } from '../../src/network/gateway.js';
import { NetworkTarget } from '../../src/network/network-target.js';
import { ArweaveWallet } from '../../src/wallet/wallet.js';
import { ChunkShareBridge } from '../../src/storage/chunk-share.js';
import { RandomxWorkerHost, RandomxH0Hasher, RandomxSquaredEntropySource } from '../../src/mining/randomx.js';
import { PackedChunkStore } from '../../src/storage/chunk-store.js';
import { ChainStateStore } from '../../src/storage/chain-state-store.js';
import { BundledResources, RunYourself } from './resources.js';
import { PageView } from './page-view.js';
import { StepExplorer, StepPace } from './step-explorer.js';
import { HoldingPanel } from './holding-panel.js';
import { SourcesPanel } from './sources-panel.js';
import { MiningPanel } from './mining-panel.js';
import { RecordsPanel } from './records-panel.js';
import { QuickStartPanel } from './quick-start-panel.js';
import { PublishingPanel } from './publishing-panel.js';
import { VdfStepRecord } from '../../src/network/vdf-client.js';
import { InstalledApp } from './installed-app.js';

class BrowserNodeApp {
  /**
   * The in-browser node: picks an identity, holds packed chunks (kept in browser storage),
   * follows the VDF and mines each step with real RandomX; it can also look up a wallet
   * and send a data transaction. Keys live in memory only.
   */
  constructor() {
    this.view = new PageView();
    this.explorer = new StepExplorer(this.view);
    // The mainnet, unless the page address names a localnet node (?localnet=<URL>).
    this.network = NetworkTarget.fromPageAddress(location.href);
    this.gateway = new ArweaveGateway({ gatewayUrls: this.network.nodeUrls ?? undefined, log: (message) => this.view.log(message, 'warn') });
    this.store = new PackedChunkStore({ log: (message) => this.view.log(message, 'warn') });
    this.chainStateStore = new ChainStateStore({ network: this.network, log: (message) => this.view.log(message, 'warn') });
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
    this.vdfSteps = new VdfStepRecord(); // steps a published block lists since its parent
    this.follower = null; // the light client's chain state, once ready (PublishingPanel)
  }

  // ---- RandomX ----

  async startRandomx() {
    this.view.setText('randomxStatus', 'building the 512 MiB cache…');
    try {
      const host = new RandomxWorkerHost(() => BundledResources.worker('randomxWorkerSource'));
      await host.ready();
      this.h0Hasher = new RandomxH0Hasher(host);
      // 32 entropies (8 MiB each, 256 MiB) cover one chunk's sub-chunks, so batches of chunks
      // sharing a bucket position reuse them instead of recomputing per batch.
      this.entropySource = new RandomxSquaredEntropySource(host, { keepEntropies: HoldingPanel.KEPT_ENTROPIES });
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

  /** The shared key's address, from the key file the page carries. */
  /**
   * An error nothing else handled: logged with its cause and where it came from, so a
   * person can retry or report it, and mining state is not left looking busy.
   */
  reportUnexpected(where, error) {
    const message = error?.message ?? String(error);
    this.view.log(`${where} failed: ${message}. Reloading the page is safe (held chunks are kept); if it happens again, the line above helps report it.`, 'error');
    console.error(error);
  }

  sharedKeyAddress() {
    return BundledResources.publicKey().address;
  }

  async useSharedKey() {
    const { jwk } = BundledResources.publicKey();
    await this.setIdentity(MiningIdentity.fromWallet(await ArweaveWallet.fromJwk(jwk)), 'the shared key that comes with this page');
  }

  /**
   * The sample block's own miner, held only to replay its solution: the block carries that
   * miner's packed sub-chunks. Never packed for, since mining for it would pay them.
   */
  async verifyAgainstSample() {
    this.loadSampleBlock();
    const identity = new MiningIdentity(Bytes.fromBase64Url(this.block.reward_addr), null, { verificationOnly: true });
    await this.setIdentity(identity, `the sample block's own miner, for checking only; this page will not pack for it`);
    this.view.elements.partitionInput.value = String(this.block.partition_number);
    this.view.elements.vdfModeReplay.checked = true;
    await this.holdChunks();
    this.view.log('verification ready: Start mining replays the sample block and should find its solution');
  }

  async useAddress() {
    try {
      const typed = MiningIdentity.fromAddress(this.view.elements.addressInput.value);
      const isSampleMiner = typed.address === BundledResources.sampleBlock().reward_addr;
      const identity = isSampleMiner ? new MiningIdentity(typed.addressBytes, null, { verificationOnly: true }) : typed;
      await this.setIdentity(identity, isSampleMiner ? `the sample block's own miner, for checking only; this page will not pack for it` : 'address only: enough to mine and look up, not to sign');
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
    // Packing is per address, so another address's chunks do not count. Saved chunks stay
    // on disk and are read in as steps need them, so storage, not memory, sets the limit.
    this.storage = this.heldStorageFor(identity);
    this.view.setText('identityAddress', identity.address);
    this.view.setText('identityStatus', note);
    this.view.elements.walletAddressInput.value = identity.address;
    this.view.setText('holdStatus', 'No data held for this address yet.');
    this.view.log(`identity set: ${identity.address}`);
    await this.restoreStoredChunks();
    this.refreshSummary();
  }

  bind() {
    // A failing action says so in the activity log, with its cause, instead of failing silently.
    const onClick = (id, handler) => this.view.elements[id].addEventListener('click', () => {
      Promise.resolve().then(() => handler.call(this)).catch((error) => this.reportUnexpected(`"${this.view.elements[id].textContent.trim()}"`, error));
    });
    window.addEventListener('unhandledrejection', (event) => this.reportUnexpected('a background task', event.reason));
    window.addEventListener('error', (event) => this.reportUnexpected('the page', event.error ?? event.message));
    onClick('generateButton', this.generateIdentity);
    onClick('quickStartButton', this.quickStart);
    onClick('sharedKeyButton', this.useSharedKey);
    onClick('verifySampleButton', this.verifyAgainstSample);
    onClick('bringChunksButton', this.bringChunksFromWebsite);
    onClick('addressButton', this.useAddress);
    onClick('keyfileButton', this.loadKeyfile);
    onClick('copyKeyfileButton', this.copyKeyfile);
    onClick('peersButton', this.findPeers);
    onClick('testSourcesButton', this.testSources);
    this.view.elements.seedInput.addEventListener('change', () => this.applySeeds());
    onClick('liveButton', this.loadLiveBlock);
    onClick('sampleButton', this.loadSampleBlock);
    onClick('holdButton', this.holdChunks);
    onClick('stopHoldButton', this.stopHolding);
    onClick('exportChunksButton', this.exportChunks);
    this.view.elements.importChunksInput.addEventListener('change', () => this.importChunks());
    onClick('startButton', this.start);
    onClick('stopButton', this.stop);
    onClick('walletButton', this.lookUpWallet);
    onClick('quoteButton', this.quoteRecord);
    onClick('sendButton', this.sendRecord);
    onClick('freeSendButton', this.sendRecordFree);
    this.view.elements.partitionInput.addEventListener('change', () => {
      this.partitionChosenByPerson = true;
      this.refreshSummary();
    });
    for (const id of ['poolTabsInput', 'poolSizeInput', 'poolFeeInput', 'poolThresholdInput']) this.view.elements[id].addEventListener('input', () => this.refreshPoolOdds());
    this.view.elements.recordInput.addEventListener('input', () => this.view.setText('recordSize', `${this.recordBytes().length} bytes`));
  }

  async run() {
    this.bind();
    new RunYourself(this.view).show();
    this.setUpMixedContentChoice();
    this.setUpStorageSlider();
    this.ownVdfServerUrl(); // restores the remembered VDF server address into its field
    this.restoreSeeds();
    this.view.setText('peerStatus', this.describeGatheredSources());
    this.view.elements.bringChunksButton.hidden = location.protocol !== 'file:';
    if (ChunkShareBridge.isShareRequest()) this.offerShare();
    // Open on the sample block, mining for the shared key. "Verify against the sample"
    // switches to the sample's own miner to replay its solution.
    this.loadSampleBlock();
    await this.useSharedKey();
    InstalledApp.register((message, tone) => this.view.log(message, tone));
    this.view.setText('revisionNote', BundledResources.revisionText());
    this.view.log(`this page is ${BundledResources.revisionText()}`);
    if (!this.network.isMainnet) {
      this.view.log(`on a ${this.network.name} at ${this.network.nodeUrls.join(', ')}, not the mainnet: its rules take any held chunk and any hash, and VDF steps are computed here`, 'warn');
    }
    this.view.log('ready: the shared key and the sample block. "Verify against the sample" replays a real solution; load the live block to mine.');
  }
}

// Each page section's logic lives in its own panel class; their methods join the app's,
// running with `this` as the app, so panels share its state (view, gateway, storage…).
for (const panel of [SourcesPanel, HoldingPanel, MiningPanel, RecordsPanel, QuickStartPanel, PublishingPanel]) {
  for (const name of Object.getOwnPropertyNames(panel.prototype)) {
    if (name !== 'constructor') Object.defineProperty(BrowserNodeApp.prototype, name, Object.getOwnPropertyDescriptor(panel.prototype, name));
  }
}

new BrowserNodeApp().run();
