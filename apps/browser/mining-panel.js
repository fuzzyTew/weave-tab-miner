// apps/browser/mining-panel.js — Mining: following the VDF, mining each step, and the expected wait.
// Its methods are mixed into BrowserNodeApp (see app.js), so `this` is the app.
import { Bytes } from '../../src/core/bytes.js';
import { ConsensusConstants } from '../../src/core/constants.js';
import { Miner } from '../../src/mining/miner.js';
import { VdfSession } from '../../src/mining/vdf.js';
import { SolutionOdds } from '../../src/mining/odds.js';
import { StorageSizing } from '../../src/mining/storage-sizing.js';
import { PeerAccess } from '../../src/network/peers.js';
import { VdfServerClient, VdfServerPool } from '../../src/network/vdf-client.js';
import { ReplayStepSource, ServerStepSource, ComputedStepSource, StepMiningLoop } from '../../src/mining/step-sources.js';
import { VdfSpotCheck } from '../../src/network/vdf-spot-check.js';
import { BundledResources } from './resources.js';
import { PageView } from './page-view.js';

export class MiningPanel {
  static REPLAY_STEP_INTERVAL_MS = 1000; // the network's VDF pace, about one step per second
  static MAX_STEP_BACKLOG = 8; // VDF-server steps mined per poll at most; older ones are skipped
  // ---- mining ----

  get isTestMode() {
    return this.view.elements.aimCheckbox.checked || Number(this.view.elements.easeSelect.value) !== 1;
  }

  /** A Miner with the test settings, and whatever the network's rules allow on top (a localnet's). */
  makeMiner() {
    const allowed = this.network.rules.minerAllowance();
    return new Miner({
      identity: this.identity, partitionNumber: this.partitionNumber, storage: this.storage, h0Hasher: this.h0Hasher,
      testMode: {
        aimRange1AtHeldData: this.view.elements.aimCheckbox.checked || allowed.aimRange1AtHeldData,
        difficultyEase: Math.max(Number(this.view.elements.easeSelect.value), allowed.difficultyEase),
      },
    });
  }

  async mineOne(stepNumber, output, source) {
    const report = await this.makeMiner().mineStep(this.session, stepNumber, output);
    this.stepsMined++;
    this.pace.record(report.timings);
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
      detail = 'Real rules throughout: the tab is building a block around it and posting it to nodes (see "Publishing" below the mining buttons).';
    }
    this.view.elements.solutionBanner.hidden = false;
    this.view.setText('solutionTitle', title);
    this.view.setText('solutionDetail', `${report.solution.kind} at step ${report.stepNumber.toLocaleString()}, nonce ${report.solution.nonce}, hash ${PageView.shortHex(report.solution.hash, 24)}. ${detail}`);
    this.view.log(`solution found at step ${report.stepNumber}`, 'good');
    this.explorer.show(report);
    // Test mode and stand-ins stop so the solution can be looked at; with real rules the
    // tab keeps mining, since every step is another chance.
    if (this.isTestMode || !this.usingRealRandomx || isSampleReplay) this.stop();
    else this.publishSolution(report);
  }

  async start() {
    if (!this.identity || !this.session) {
      this.view.log('pick an identity and load a block first', 'warn');
      return;
    }
    await this.randomxReady;
    this.view.elements.startButton.disabled = true;
    await this.repackEverythingForThisAddress();
    this.running = true;
    this.holdScreenAwake();
    this.pace.reset();
    this.stepsSkipped = 0;
    this.stepsMissed = 0;
    this.gapsFilled = 0;
    this.pollMs = [];
    this.lastMinedStep = -1; // a VDF server's backlog from before this start is stale
    this.view.elements.solutionBanner.hidden = true;
    this.view.elements.startButton.disabled = true;
    this.view.elements.stopButton.disabled = false;
    this.mineFromChosenSource();
    if (this.blockOrigin === 'live') this.followTip();
    if (!this.publishing.ready) this.prepareToPublish();
    this.fillStorageInBackground();
  }

  static TIP_POLL_MS = 20_000; // blocks come about every 2 minutes; a new tip changes the seed H0 uses
  // After posting a block, how often and how long to look for nodes to make it the tip.
  static OWN_TIP_POLL_MS = 2_000;
  static OWN_TIP_WAIT_MS = 30_000;

  /**
   * Fetches the current block every TIP_POLL_MS while mining, so the difficulty and the
   * weave bound follow the chain instead of the block loaded at the start; the latest VDF
   * server update's seeds are kept on top.
   */
  async followTip() {
    if (!this.running) return;
    // One check at a time; a call during one asks it to check again straight after.
    if (this.followingTip) {
      this.tipCheckWanted = true;
      return;
    }
    this.followingTip = true;
    this.tipCheckWanted = false;
    try {
      const block = await this.gateway.currentBlock();
      if (Number(block.height) > Number(this.block.height)) {
        this.block = block;
        this.session = VdfSession.fromBlock(block);
        if (this.latestVdfUpdate) this.session = this.session.withVdfUpdate(this.latestVdfUpdate);
        this.view.setText('networkHeight', this.session.height.toLocaleString());
        this.view.log(`following the chain: now on block ${this.session.height}`);
        this.followToTip(block);
      }
    } catch (error) {
      this.view.log(`could not check for a new block: ${error.message.split('\n')[0]}`, 'warn');
    }
    this.followingTip = false;
    // While a block this tab posted is not yet the tip (nodes take a few seconds to check
    // it), look again soon rather than at the next regular check.
    const awaiting = this.awaitedTip && this.awaitedTip.hash !== this.block.indep_hash && Date.now() < this.awaitedTip.until;
    if (!awaiting) this.awaitedTip = null;
    const delay = this.tipCheckWanted ? 0 : awaiting ? MiningPanel.OWN_TIP_POLL_MS : MiningPanel.TIP_POLL_MS;
    if (this.running) this.tipTimer = setTimeout(() => this.followTip(), delay);
  }

  /**
   * Checks for a new tip now instead of at the next TIP_POLL_MS, keeping one polling loop:
   * after a node takes this tab's block, mining moves onto it at once.
   */
  checkTipNow({ awaitedHash = null } = {}) {
    if (!this.running) return;
    if (awaitedHash) this.awaitedTip = { hash: awaitedHash, until: Date.now() + MiningPanel.OWN_TIP_WAIT_MS };
    clearTimeout(this.tipTimer);
    this.followTip();
  }

  /**
   * Keeps the screen on while mining (the Screen Wake Lock API), so a plugged-in phone or
   * laptop does not sleep and pause the tab. Browsers drop the lock when the tab is hidden;
   * it is taken again when the tab shows. Fails quietly where unsupported.
   */
  async holdScreenAwake() {
    if (!this.running || !navigator.wakeLock || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      if (!this.wakeLockListening) {
        this.wakeLockListening = true;
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.holdScreenAwake(); });
      }
    } catch (error) {
      this.view.log(`could not keep the screen on: ${error.message}`, 'warn');
    }
  }

  stop() {
    this.wakeLock?.release();
    this.running = false;
    this.stepLoop?.stop();
    clearTimeout(this.tipTimer);
    this.view.elements.startButton.disabled = false;
    this.view.elements.stopButton.disabled = true;
  }

  /** The block's last REPLAY_STEP_COUNT steps, ending on the step it was mined at, one a second. */
  static REPLAY_STEP_COUNT = 15;

  /**
   * Mines the steps of the VDF source chosen in the page (a StepSource from
   * src/mining/step-sources.js) until it ends or mining stops; says why it ended.
   */
  async mineFromChosenSource() {
    const source = this.view.elements.vdfModeLocal.checked ? this.computedStepSource()
      : this.view.elements.vdfModeServer.checked ? await this.serverStepSource()
        : new ReplayStepSource({ steps: this.session.steps().slice(-MiningPanel.REPLAY_STEP_COUNT), intervalMs: MiningPanel.REPLAY_STEP_INTERVAL_MS });
    if (!source || !this.running) return;
    this.stepLoop = new StepMiningLoop({ source, mineStep: (stepNumber, output, label) => this.mineOne(stepNumber, output, label) });
    const { ended, error } = await this.stepLoop.run();
    if (ended === 'finished') this.view.log('replayed every step in this block; choose another VDF source to keep going', 'warn');
    if (ended === 'failed') this.view.log(`VDF steps stopped: ${error.message}`, 'error');
    if (ended !== 'stopped') this.stop();
  }

  /**
   * Steps from public VDF servers (a VdfServerPool): the only way to keep the network's
   * pace without computing the VDF here. Resolves null, with what to try, when none answers.
   */
  async serverStepSource() {
    const candidates = this.vdfServerCandidates();
    this.view.setText('vdfStatus', `Looking for VDF servers among ${candidates.length} candidates…`);
    const { pool, failures } = await VdfServerPool.connect(candidates, { record: this.vdfSteps, log: (message) => this.view.log(message, 'warn') });
    if (!pool) {
      this.showVdfTroubleshooting(failures);
      this.stop();
      return null;
    }
    this.view.setText('vdfStatus', `Getting VDF steps from ${pool.clients.length} server${pool.clients.length === 1 ? '' : 's'}: ${pool.serverUrls.join(', ')}.`);
    this.vdfPool = pool;
    return new ServerStepSource({
      pool, lastMinedStep: () => this.lastMinedStep, pollIntervalMs: VdfServerClient.POLL_INTERVAL_MS, maxBacklog: MiningPanel.MAX_STEP_BACKLOG,
      onPoll: ({ newest, newestFrom, gapFilled, missing, skipped, pollMs }) => {
        this.pollMs.push(pollMs);
        if (this.pollMs.length > 20) this.pollMs.shift();
        this.latestVdfUpdate = newest;
        this.session = this.session.withVdfUpdate(newest);
        this.spotCheckVdf(pool, newest, newestFrom);
        if (gapFilled) this.gapsFilled++;
        this.stepsMissed += missing;
        this.stepsSkipped += skipped;
      },
      onError: (error) => this.view.log(`VDF servers: ${error.message}`, 'warn'),
    });
  }

  /** When no VDF server answers: each one tried and why, and what to try next, in order. */
  showVdfTroubleshooting(failures) {
    const steps = [
      'Add a VDF server address you know of below, and start again.',
      PeerAccess.blockedReason() ? 'Use the downloaded copy, or allow insecure content for this site: the public VDF servers use plain http.' : null,
      'Try another network (a phone hotspot, say); some networks block these servers while letting gateways through.',
      'Tor reaches them too, at the cost of running the device through it.',
      '"Compute VDF steps in this tab" needs no server, but is about 20 times too slow to publish a block.',
    ].filter(Boolean);
    const list = document.createElement('ul');
    for (const { url, reason } of failures) {
      const item = document.createElement('li');
      item.textContent = `${url}: ${reason}`;
      list.append(item);
    }
    const what = document.createElement('ol');
    for (const step of steps) {
      const item = document.createElement('li');
      item.textContent = step;
      what.append(item);
    }
    const status = this.view.elements.vdfStatus;
    status.replaceChildren(`No VDF server answered. Tried:`, list, 'What to try:', what);
  }

  /** Steps computed in a worker here, carrying on from the last computed step after a restart. */
  computedStepSource() {
    if (!this.vdfWorker) {
      this.vdfWorker = BundledResources.worker('vdfWorkerSource');
      this.vdfWorker.onerror = (event) => this.vdfWorkerRequest?.reject(new Error(`the VDF worker could not run: ${event.message || 'the browser gave no reason'}`));
      this.vdfWorker.onmessage = ({ data }) => {
        const request = this.vdfWorkerRequest;
        this.vdfWorkerRequest = null;
        if (data.error) request?.reject(new Error(`the VDF worker failed: ${data.error}`));
        else request?.resolve(data);
      };
    }
    return new ComputedStepSource({
      start: { stepNumber: this.localStepNumber ?? this.session.latestStepNumber, output: this.localOutput ?? this.session.stepOutputsNewestFirst[0] },
      // One request at a time: the source asks for the next only after the last arrived.
      // Assumption: on reset steps the session's next_seed is mixed in (ar_nonce_limiter:maybe_add_entropy).
      computeStep: ({ stepNumber, previousOutput }) => new Promise((resolve, reject) => {
        this.vdfWorkerRequest = { resolve, reject };
        this.vdfWorker.postMessage({ stepNumber, previousOutput, iterationsPerCheckpoint: this.session.vdfDifficulty, resetSeed: this.session.nextSeed });
      }),
      onRequest: (stepNumber, lastSeconds) => {
        const pace = lastSeconds === null ? '' : ` The last took ${lastSeconds.toFixed(1)} s here; the network does one per second.`;
        this.view.setText('vdfStatus', `Computing step ${stepNumber.toLocaleString()}…${pace}`);
      },
      onComputed: ({ stepNumber, output, checkpoints }) => {
        this.vdfSteps.addComputedStep(stepNumber, checkpoints);
        this.localStepNumber = stepNumber;
        this.localOutput = output;
      },
    });
  }

  /**
   * Now and then, recomputes one checkpoint of the newest server step in a worker of its
   * own (VdfSpotCheck); a server whose step does not match is dropped from the pool.
   */
  async spotCheckVdf(pool, update, serverUrl) {
    this.vdfSpotCheck ??= new VdfSpotCheck({ computeCheckpoint: (request) => this.computeCheckpointInWorker(request) });
    if (!this.vdfSpotCheck.due(Date.now())) return;
    try {
      const result = await this.vdfSpotCheck.check(update, [this.session.vdfDifficulty, update.nextVdfDifficulty]);
      if (!result.checked || result.matches) return;
      const problem = `VDF server ${serverUrl} sent step ${result.stepNumber} with a checkpoint (${result.index + 1} of 25) that does not follow`;
      // The last server is kept (mining would stop), but flagged: its steps may be worthless.
      if (pool.clients.length === 1) {
        this.view.log(`${problem}; it is the only server answering, so it is kept, but solutions on its steps may be worthless`, 'error');
        return;
      }
      const remaining = pool.drop(serverUrl);
      this.view.log(`${problem}; it is dropped, ${remaining} server${remaining === 1 ? '' : 's'} left`, 'error');
    } catch (error) {
      this.view.log(`could not spot-check the VDF server's step: ${error.message}`, 'warn');
    }
  }

  /** One VDF checkpoint, computed in a worker kept for spot checks. */
  computeCheckpointInWorker({ saltNumber, input, iterationsPerCheckpoint }) {
    if (!this.vdfCheckWorker) {
      this.vdfCheckWorker = BundledResources.worker('vdfWorkerSource');
      this.vdfCheckRequests = new Map();
      this.vdfCheckWorker.onmessage = ({ data }) => {
        const request = this.vdfCheckRequests.get(data.checkpointRequest);
        if (!request) return;
        this.vdfCheckRequests.delete(data.checkpointRequest);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data.output);
      };
    }
    const id = (this.vdfCheckSequence = (this.vdfCheckSequence ?? 0) + 1);
    return new Promise((resolve, reject) => {
      this.vdfCheckRequests.set(id, { resolve, reject });
      this.vdfCheckWorker.postMessage({ checkpointRequest: id, saltNumber, input, iterationsPerCheckpoint });
    });
  }

  // ---- odds ----

  refreshSummary() {
    this.view.setText('heldBytes', PageView.formatBytes(this.storage.byteCount));
    this.view.setText('heldChunks', `${this.storage.chunkCount} chunk${this.storage.chunkCount === 1 ? '' : 's'}`);
    if (!this.session) return;
    const stepsPerSecond = this.running ? this.pace.stepsPerSecond(SolutionOdds.NETWORK_STEPS_PER_SECOND) : SolutionOdds.NETWORK_STEPS_PER_SECOND;
    const odds = { storage: this.storage, partitionNumber: this.partitionNumber, session: this.session, stepsPerSecond };
    const seconds = SolutionOdds.expectedSecondsPerSolution(odds);
    this.view.setText('expectedWait', PageView.formatDuration(seconds));
    const { fullSpeedSeconds, factors } = SolutionOdds.waitBreakdown({ ...odds, quotaBytes: this.storageQuotaBytes });
    const pace = this.running ? `Measured pace: ${stepsPerSecond.toFixed(2)} steps a second. ${this.pace.describe(SolutionOdds.NETWORK_STEPS_PER_SECOND)}${this.vdfServerNote()}` : 'Assumes the network\'s pace of one step a second until mining starts.';
    this.view.setText('limitHeadline', `A miner holding the whole partition and the whole weave would wait about ${PageView.formatDuration(fullSpeedSeconds)}. Each shortfall below multiplies that; they compound. ${pace}`);
    this.view.fillLimits(factors);
    const hitChance = SolutionOdds.heldRangeHitChance(odds);
    this.view.setText('rangeHitNote', hitChance > 0
      ? `Range 1 touches a chunk this tab holds about once every ${PageView.formatDuration(1 / (hitChance * stepsPerSecond))} (${(hitChance * 100).toPrecision(2)}% of steps). Each held chunk in range gives ${ConsensusConstants.noncesPerRecallRange / (ConsensusConstants.recallRangeSize / ConsensusConstants.DATA_CHUNK_SIZE)} tries. Spreading chunks out makes touches more frequent but smaller, and holding them side by side makes them rarer but larger; the expected wait above is the same either way.`
      : `No chunks held in partition ${this.partitionNumber}, so no step can try anything.`);
    this.refreshSizing();
    this.view.setText('waitNote', this.usingRealRandomx ? 'Real rules: a solution here would be a real one.' : 'Stand-in RandomX: solutions would not be real.');
  }

  /**
   * How big a disk: what holding the whole partition would cost here, and the held sizes
   * where this app's limits bind (StorageSizing), from rates measured in this tab where
   * there are any.
   */
  refreshSizing() {
    const timings = this.running ? this.pace.averageTimings() : null;
    // Waiting time per chunk read while mining: reads overlap hashing, so this is a floor.
    const readMsPerChunk = timings?.chunksRead >= 1 ? timings.loadMs / timings.chunksRead : null;
    const measured = { readMsPerChunk, fillBytesPerSecond: this.fillMeter.perSecond };
    const weaveBytes = Number(this.session.partitionUpperBound);
    // Steps at the network's pace: reads must fit in that to keep up.
    const full = new StorageSizing({ heldBytes: StorageSizing.partitionBytes, weaveBytes, measured, stepSeconds: 1 / SolutionOdds.NETWORK_STEPS_PER_SECOND });
    const readSource = readMsPerChunk === null ? 'estimated for a fast disk, until mining reads some held chunks' : 'as measured while mining here';
    const fill = full.fillSeconds === null ? 'filling it takes as long as fetching and packing allow (measured once a fill runs)'
      : `filling it would take about ${PageView.formatDuration(full.fillSeconds)} at the ${PageView.formatBytes(full.measured.fillBytesPerSecond)}/s measured here`;
    this.view.setText('sizingNote', `The wait shrinks in step with the share of partition ${this.partitionNumber} held (twice the data, half the wait), up to the whole partition, ${PageView.formatBytes(StorageSizing.partitionBytes)}. Holding all of it here would mean reading about ${full.chunksReadPerStep.toFixed(0)} chunks a step (${PageView.formatBytes(full.readBytesPerSecond)}/s; about ${Math.round(full.readMsPerStep)} ms of each step, ${readSource}), an index of ${PageView.formatBytes(full.indexMemoryBytes)} in memory, about ${PageView.formatDuration(full.startupSeconds)} listing chunks at each start; ${fill}. Chrome allows a site about ${Math.round(StorageSizing.CHROME_DISK_SHARE * 100)}% of its disk, so that needs a disk of about ${PageView.formatBytes(full.chromeDiskBytes)}. Where this app's limits bind first:`);
    this.view.fillLabeledList('sizingLimits', full.limits()
      .filter((limit) => Number.isFinite(limit.bytes))
      .map((limit) => ({ label: `about ${PageView.formatBytes(limit.bytes)} held`, text: limit.explanation, className: this.storage.byteCount >= limit.bytes ? 'limit-reached' : '' })));
  }

  /** How the VDF server kept up: poll time, gaps between polls, and steps lost or skipped. */
  vdfServerNote() {
    if (!this.pollMs?.length) return '';
    const meanPoll = this.pollMs.reduce((total, ms) => total + ms, 0) / this.pollMs.length;
    const parts = [`Each round of VDF server requests takes about ${Math.round(meanPoll)} ms`];
    if (this.gapsFilled) parts.push(`${this.gapsFilled} gaps between requests were filled from the server's session`);
    if (this.stepsMissed) parts.push(`${this.stepsMissed} steps were missed`);
    if (this.stepsSkipped) parts.push(`${this.stepsSkipped} were skipped while mining fell behind`);
    return ` ${parts.join('; ')}.`;
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
}
