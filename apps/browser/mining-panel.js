// apps/browser/mining-panel.js — Mining: following the VDF, mining each step, and the expected wait.
// Its methods are mixed into BrowserNodeApp (see app.js), so `this` is the app.
import { Bytes } from '../../src/core/bytes.js';
import { ConsensusConstants } from '../../src/core/constants.js';
import { Miner } from '../../src/mining/miner.js';
import { VdfSession } from '../../src/mining/vdf.js';
import { SolutionOdds } from '../../src/mining/odds.js';
import { PeerAccess } from '../../src/network/peers.js';
import { VdfServerClient, VdfServerPool } from '../../src/network/vdf-client.js';
import { BundledResources } from './resources.js';
import { PageView } from './page-view.js';

export class MiningPanel {
  static REPLAY_STEP_INTERVAL_MS = 1000; // the network's VDF pace, about one step per second
  static MAX_STEP_BACKLOG = 8; // VDF-server steps mined per poll at most; older ones are skipped
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
    if (this.view.elements.vdfModeLocal.checked) this.runLocalVdf();
    else if (this.view.elements.vdfModeServer.checked) this.runVdfServer();
    else this.runReplay();
    if (this.blockOrigin === 'live') this.followTip();
    if (!this.follower) this.prepareToPublish();
    this.fillStorageInBackground();
  }

  static TIP_POLL_MS = 20_000; // blocks come about every 2 minutes; a new tip changes the seed H0 uses

  /**
   * Fetches the current block every TIP_POLL_MS while mining, so the difficulty and the
   * weave bound follow the chain instead of the block loaded at the start; the latest VDF
   * server update's seeds are kept on top.
   */
  async followTip() {
    if (!this.running) return;
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
    if (this.running) this.tipTimer = setTimeout(() => this.followTip(), MiningPanel.TIP_POLL_MS);
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
    clearTimeout(this.replayTimer);
    clearTimeout(this.serverTimer);
    clearTimeout(this.tipTimer);
    this.view.elements.startButton.disabled = false;
    this.view.elements.stopButton.disabled = true;
  }

  /** The block's last REPLAY_STEP_COUNT steps, ending on the step it was mined at, one a second. */
  static REPLAY_STEP_COUNT = 15;

  runReplay() {
    const steps = this.session.steps().slice(-MiningPanel.REPLAY_STEP_COUNT);
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
      if (this.running) this.replayTimer = setTimeout(next, MiningPanel.REPLAY_STEP_INTERVAL_MS);
    };
    next();
  }

  /**
   * Steps from a public VDF server: the only way to keep the network's pace without
   * computing the VDF here. Falls back to telling the person when none answers.
   */
  /**
   * Steps from public VDF servers (a VdfServerPool): the only way to keep the network's
   * pace without computing the VDF here. Falls back to telling the person when none answers.
   */
  async runVdfServer() {
    const candidates = this.vdfServerCandidates();
    this.view.setText('vdfStatus', `Looking for VDF servers among ${candidates.length} candidates…`);
    const pool = await VdfServerPool.connect(candidates, { record: this.vdfSteps, log: (message) => this.view.log(message, 'warn') });
    if (!pool) {
      const downloadHint = PeerAccess.blockedReason() ? ' The public VDF servers use plain http, which a downloaded copy opened from disk can reach.' : '';
      this.view.setText('vdfStatus', `No VDF server answered this page.${downloadHint} "Compute VDF steps in this tab" works without one, but uses a whole CPU core.`);
      this.stop();
      return;
    }
    this.view.setText('vdfStatus', `Getting VDF steps from ${pool.clients.length} server${pool.clients.length === 1 ? '' : 's'}: ${pool.serverUrls.join(', ')}.`);
    this.vdfPool = pool;
    const poll = async () => {
      if (!this.running) return;
      try {
        const pollStarted = performance.now();
        const { newest, fresh, gapFilled, missing } = await pool.poll(this.lastMinedStep);
        this.pollMs.push(performance.now() - pollStarted);
        if (this.pollMs.length > 20) this.pollMs.shift();
        this.latestVdfUpdate = newest;
        this.session = this.session.withVdfUpdate(newest);
        if (gapFilled) this.gapsFilled++;
        this.stepsMissed += missing;
        // Steps well behind the newest are stale, so only the newest few are mined: at the
        // start, and whenever mining falls behind; the skipped ones are counted.
        const kept = fresh.slice(-MiningPanel.MAX_STEP_BACKLOG);
        if (this.lastMinedStep >= 0) this.stepsSkipped += fresh.length - kept.length;
        for (const [stepNumber, output] of kept) {
          if (!this.running) return;
          await this.mineOne(stepNumber, output, 'VDF server');
        }
      } catch (error) {
        this.view.log(`VDF servers: ${error.message}`, 'warn');
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

  // ---- odds ----

  refreshSummary() {
    this.view.setText('heldBytes', PageView.formatBytes(this.storage.byteCount));
    this.view.setText('heldChunks', `${this.storage.packedChunks.size} chunk${this.storage.packedChunks.size === 1 ? '' : 's'}`);
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
    this.view.setText('waitNote', this.usingRealRandomx ? 'Real rules: a solution here would be a real one.' : 'Stand-in RandomX: solutions would not be real.');
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
