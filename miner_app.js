// miner_app.js — the page's controller. Mining, wallet, network and transaction logic live in
// the arweave_*.js library modules; this file only wires the page's controls and displays to them.
import {
  Bytes, ConsensusConstants, Replica29Layout, MiningIdentity, ChunkPacker, StubEntropySource,
  StubH0Hasher, HeldStorage, Miner, VdfSession, SolutionOdds,
} from './arweave_miner.js';
import { ArweaveGateway } from './arweave_gateway.js';
import { ArweaveWallet } from './arweave_wallet.js';
import { DataTransaction } from './arweave_transaction.js';

class BundledResources {
  /**
   * The sample block and the VDF worker come either embedded in the page (the single-file
   * build, which opens from disk with no web server) or as separate files next to it.
   * Browsers refuse to fetch neighbouring files for a page opened from file://, hence both.
   */
  static embeddedText(elementId) {
    return document.getElementById(elementId)?.textContent ?? null;
  }

  static async sampleBlock() {
    const embedded = BundledResources.embeddedText('sampleBlockData');
    if (embedded) return JSON.parse(embedded);
    const response = await fetch('./sample_block.json');
    return response.json();
  }

  static vdfWorker() {
    const embedded = BundledResources.embeddedText('vdfWorkerSource');
    // The embedded worker has its imports already inlined, so it runs as a classic script:
    // Chromium refuses module workers from blob: URLs on pages opened from file://.
    if (embedded) return new Worker(URL.createObjectURL(new Blob([embedded], { type: 'text/javascript' })));
    return new Worker(new URL('./vdf_worker.js', import.meta.url), { type: 'module' });
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

  addStepRow(report, source) {
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
}

class BrowserNodeApp {
  /**
   * The in-browser node: picks an identity, holds a few packed chunks, follows the VDF
   * and mines each step; it can also look up a wallet and send a data transaction.
   * State lives in memory only; closing the tab forgets it, keys included.
   */
  static REPLAY_STEP_INTERVAL_MS = 1000; // the network's VDF pace, about one step per second
  static FOLLOW_POLL_INTERVAL_MS = 60_000; // blocks come about every two minutes

  constructor() {
    this.view = new PageView();
    this.gateway = new ArweaveGateway({ log: (message) => this.view.log(message, 'warn') });
    this.identity = null;
    this.session = null;
    this.storage = new HeldStorage();
    this.entropySource = new StubEntropySource();
    this.h0Hasher = new StubH0Hasher();
    this.running = false;
    this.stepsMined = 0;
    this.lastMinedStep = -1;
    this.worker = null;
  }

  // ---- identity ----

  async generateIdentity() {
    this.view.setText('identityStatus', 'Generating a 4096-bit key…');
    this.setIdentity(MiningIdentity.fromWallet(await ArweaveWallet.generate()), 'new key made in this tab and never saved; it can sign transactions');
  }

  useAddress() {
    try {
      this.setIdentity(MiningIdentity.fromAddress(this.view.elements.addressInput.value), 'address only: enough to mine and look up, not to sign');
    } catch (error) {
      this.view.setText('identityStatus', `That address did not work: ${error.message}. It should be 43 characters.`);
    }
  }

  async loadKeyfile() {
    try {
      const wallet = await ArweaveWallet.fromJwk(JSON.parse(this.view.elements.keyfileInput.value));
      this.view.elements.keyfileInput.value = '';
      this.setIdentity(MiningIdentity.fromWallet(wallet), 'keyfile loaded into this tab only; it can sign transactions');
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

  setIdentity(identity, note) {
    this.identity = identity;
    this.storage = new HeldStorage(); // packing is per address, so old packed data no longer counts
    this.view.setText('identityAddress', identity.address);
    this.view.setText('identityStatus', note);
    this.view.elements.walletAddressInput.value = identity.address;
    this.view.log(`identity set: ${identity.address}`);
    this.refreshSummary();
  }

  // ---- network ----

  async loadLiveBlock() {
    this.view.setText('networkStatus', 'Fetching the current block…');
    try {
      this.useBlock(await this.gateway.currentBlock(), 'live');
      return true;
    } catch (error) {
      this.view.setText('networkStatus', 'No gateway answered. The network here may block them; the sample block still works.');
      this.view.log(error.message, 'error');
      return false;
    }
  }

  async loadSampleBlock() {
    this.useBlock(await BundledResources.sampleBlock(), 'sample');
  }

  useBlock(block, origin) {
    this.block = block;
    this.blockOrigin = origin;
    this.session = VdfSession.fromBlock(block);
    const partitionInput = this.view.elements.partitionInput;
    if (!partitionInput.value) partitionInput.value = String(block.partition_number ?? 0);
    this.view.setText('networkHeight', this.session.height.toLocaleString());
    this.view.setText('networkStep', this.session.latestStepNumber.toLocaleString());
    this.view.setText('networkStatus', `${origin === 'live' ? 'Live' : 'Sample'} block ${this.session.height}; ${this.session.stepOutputsNewestFirst.length} VDF steps; weave ${PageView.formatBytes(Number(this.session.partitionUpperBound))}`);
    this.view.log(`using ${origin} block at height ${this.session.height}`);
    this.refreshSummary();
    this.refreshPoolOdds();
  }

  // ---- storage ----

  get partitionNumber() {
    return Number(this.view.elements.partitionInput.value || 0);
  }

  async holdChunks() {
    if (!this.identity || !this.session) {
      this.view.log('pick an identity and load a block first', 'warn');
      return;
    }
    const packer = new ChunkPacker(this.identity, this.entropySource);

    if (this.blockOrigin === 'sample') {
      // Offline: the sample block carries the two real chunks its miner proved access to.
      for (const [chunkField, byteField] of [['poa', 'recall_byte'], ['poa2', 'recall_byte2']]) {
        const endOffset = Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField]));
        this.storage.add(endOffset, packer.packChunk(Bytes.fromBase64Url(this.block[chunkField].unpacked_chunk), endOffset));
        this.view.log(`packed sample chunk ending at byte ${endOffset} for ${this.identity.address.slice(0, 8)}…`, 'good');
      }
      this.refreshSummary();
      return;
    }

    const wanted = Number(this.view.elements.chunkCountInput.value || 4);
    const partitionStart = BigInt(this.partitionNumber) * ConsensusConstants.PARTITION_SIZE;
    const partitionEnd = partitionStart + ConsensusConstants.PARTITION_SIZE;
    const windowEnd = partitionEnd < this.session.partitionUpperBound ? partitionEnd : this.session.partitionUpperBound;
    if (windowEnd <= partitionStart) {
      this.view.log(`partition ${this.partitionNumber} is past the end of the weave`, 'error');
      return;
    }
    for (let index = 0; index < wanted; index++) {
      const weaveByte = partitionStart + BigInt(Math.floor(Math.random() * Number(windowEnd - partitionStart)));
      try {
        const chunk = Bytes.fromBase64Url((await this.gateway.chunkJson(weaveByte)).chunk);
        // Approximation: the chunk is filed under the 256 KiB bucket holding the byte asked
        // for. Exact would place it by its own end offset from its data_path.
        const endOffset = Replica29Layout.bucketEndOffsetForByte(weaveByte);
        this.storage.add(endOffset, packer.packChunk(chunk, endOffset));
        this.view.log(`fetched and packed ${PageView.formatBytes(chunk.length)} at byte ${weaveByte}`, 'good');
      } catch (error) {
        this.view.log(`chunk at byte ${weaveByte} failed: ${error.message.split('\n')[0]}`, 'error');
      }
      this.refreshSummary();
    }
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

  mineOne(stepNumber, output, source) {
    const report = this.makeMiner().mineStep(this.session, stepNumber, output);
    this.stepsMined++;
    this.lastMinedStep = Math.max(this.lastMinedStep, stepNumber);
    this.view.setText('stepsMined', this.stepsMined.toLocaleString());
    this.view.addStepRow(report, source);
    if (report.solution) this.announceSolution(report);
  }

  announceSolution(report) {
    this.view.elements.solutionBanner.hidden = false;
    this.view.setText('solutionTitle', this.isTestMode ? 'Solution found! (test mode)' : 'Solution found!');
    this.view.setText('solutionDetail', `${report.solution.kind} at step ${report.stepNumber}, nonce ${report.solution.nonce}, hash ${PageView.shortHex(report.solution.hash, 24)}. ` +
      (this.isTestMode ? 'Test mode eased the rules, so the network would reject this.' : 'H0 and packing are stand-ins here, so the network would still reject it.'));
    this.view.log(`solution found at step ${report.stepNumber}`, 'good');
    this.stop();
  }

  start() {
    if (!this.identity || !this.session) {
      this.view.log('pick an identity and load a block first', 'warn');
      return;
    }
    this.running = true;
    this.view.elements.solutionBanner.hidden = true;
    this.view.elements.startButton.disabled = true;
    this.view.elements.stopButton.disabled = false;
    if (this.view.elements.vdfModeLocal.checked) this.runLocalVdf();
    else if (this.view.elements.vdfModeFollow.checked) this.runFollow();
    else this.runReplay();
  }

  stop() {
    this.running = false;
    clearTimeout(this.replayTimer);
    clearTimeout(this.followTimer);
    this.view.elements.startButton.disabled = false;
    this.view.elements.stopButton.disabled = true;
  }

  runReplay() {
    const steps = this.session.steps();
    let index = 0;
    const next = () => {
      if (!this.running) return;
      if (index >= steps.length) {
        this.view.log('replayed every step in this block; choose another VDF source to keep going', 'warn');
        this.stop();
        return;
      }
      const [stepNumber, output] = steps[index++];
      this.mineOne(stepNumber, output, 'block');
      this.replayTimer = setTimeout(next, BrowserNodeApp.REPLAY_STEP_INTERVAL_MS);
    };
    next();
  }

  /**
   * Poll the network for new blocks and mine every step each one adds. Approximation:
   * steps arrive minutes late, so a real solution found this way could already be stale;
   * a real node gets steps each second from a VDF server or computes them itself.
   */
  runFollow() {
    const poll = async () => {
      if (!this.running) return;
      if (await this.loadLiveBlock()) {
        const fresh = this.session.steps(this.lastMinedStep);
        this.view.setText('vdfStatus', `following the network: ${fresh.length} new steps in block ${this.session.height}`);
        for (const [stepNumber, output] of fresh) {
          if (!this.running) return;
          this.mineOne(stepNumber, output, 'network');
        }
      } else {
        this.view.setText('vdfStatus', 'could not reach a gateway; trying again in a minute');
      }
      this.followTimer = setTimeout(poll, BrowserNodeApp.FOLLOW_POLL_INTERVAL_MS);
    };
    poll();
  }

  runLocalVdf() {
    if (!this.worker) {
      this.worker = BundledResources.vdfWorker();
      this.worker.onerror = (event) => {
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
      this.worker.postMessage({ stepNumber: stepNumber + 1, previousOutput, iterationsPerCheckpoint: this.session.vdfDifficulty, resetSeed: this.session.nextSeed });
    };
    this.worker.onmessage = ({ data }) => {
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
      if (this.running) this.mineOne(stepNumber, previousOutput, 'this tab');
      requestNext();
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
      this.view.setText('walletStatus', failed.length === 3 ? 'No gateway answered.' : `Checked at ${new Date().toLocaleTimeString()}.`);
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
      this.view.setText('recordStatus', 'Could not get a price; no gateway answered.');
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
      this.view.setText('recordStatus', `Sent. The network replied "${reply.slice(0, 80)}". It should be readable at arweave.net/${transaction.id} within minutes.`);
      this.view.elements.recordLink.href = `https://arweave.net/${transaction.id}`;
      this.view.elements.recordLink.textContent = `arweave.net/${transaction.id}`;
      this.view.log(`record transaction ${transaction.id} sent`, 'good');
    } catch (error) {
      const lacksFunds = /balance|funds|insufficient/i.test(error.message);
      this.view.setText('recordStatus', lacksFunds ? 'Refused: this key has no AR to pay the fee yet.' : `Not sent: ${error.message.split('\n')[0]}`);
      this.view.log(error.message.split('\n')[0], 'error');
    }
  }

  // ---- odds ----

  refreshSummary() {
    this.view.setText('heldBytes', PageView.formatBytes(this.storage.byteCount));
    this.view.setText('heldChunks', `${this.storage.packedChunks.size} chunk${this.storage.packedChunks.size === 1 ? '' : 's'}`);
    if (!this.session) return;
    const seconds = SolutionOdds.expectedSecondsPerSolution({ storage: this.storage, partitionNumber: this.partitionNumber, session: this.session });
    this.view.setText('expectedWait', PageView.formatDuration(seconds));
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
  }

  bind() {
    const onClick = (id, handler) => this.view.elements[id].addEventListener('click', () => handler.call(this));
    onClick('generateButton', this.generateIdentity);
    onClick('addressButton', this.useAddress);
    onClick('keyfileButton', this.loadKeyfile);
    onClick('copyKeyfileButton', this.copyKeyfile);
    onClick('liveButton', this.loadLiveBlock);
    onClick('sampleButton', this.loadSampleBlock);
    onClick('holdButton', this.holdChunks);
    onClick('startButton', this.start);
    onClick('stopButton', this.stop);
    onClick('walletButton', this.lookUpWallet);
    onClick('quoteButton', this.quoteRecord);
    onClick('sendButton', this.sendRecord);
    this.view.elements.partitionInput.addEventListener('change', () => this.refreshSummary());
    for (const id of ['poolTabsInput', 'poolSizeInput']) this.view.elements[id].addEventListener('input', () => this.refreshPoolOdds());
    this.view.elements.recordInput.addEventListener('input', () => this.view.setText('recordSize', `${this.recordBytes().length} bytes`));
  }

  async run() {
    this.bind();
    // Open in a working state: the sample block, mining for the address that won it.
    await this.loadSampleBlock();
    this.view.elements.addressInput.value = this.block.reward_addr;
    this.useAddress();
    this.view.setText('identityStatus', 'Default: the address that mined the sample block, possibly a pool. Anything found would pay it, not you.');
    await this.holdChunks();
    this.view.log('ready: sample block loaded and its two chunks packed. Press Start mining.');
  }
}

new BrowserNodeApp().run();
