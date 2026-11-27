// apps/node/miner.mjs — server mode: the same mining library as the page, run from Node 18+.
//
//   node apps/node/miner.mjs --address <43-char address> [--partition 62] [--chunks 16]
//                       [--vdf server|local|replay] [--sample data/sample-block.json]
//                       [--stub-randomx] [--test-ease 1000000000] [--aim-at-held]
//
// --sample uses a saved block (and its two chunks) instead of the network.
// --stub-randomx swaps real RandomX for SHA-256 stand-ins (fast, but finds nothing real).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bytes } from '../../src/core/bytes.js';
import { Replica29Layout, StubEntropySource } from '../../src/mining/packing.js';
import { MiningIdentity } from '../../src/mining/identity.js';
import { StubH0Hasher } from '../../src/mining/mining-math.js';
import { HeldStorage } from '../../src/mining/held-storage.js';
import { Miner } from '../../src/mining/miner.js';
import { VdfSession, VdfChain } from '../../src/mining/vdf.js';
import { SolutionOdds } from '../../src/mining/odds.js';
import { ArweaveGateway } from '../../src/network/gateway.js';
import { VdfServerClient, VdfServerPool } from '../../src/network/vdf-client.js';
import { ChunkFiller } from '../../src/network/chunk-filler.js';
import { ReplayStepSource, ServerStepSource, ComputedStepSource, StepMiningLoop } from '../../src/mining/step-sources.js';
import { RandomxBundle, RandomxDirectHost, RandomxH0Hasher, RandomxSquaredEntropySource } from '../../src/mining/randomx.js';

class CommandLineOptions {
  /**
   * `--name value` pairs and bare `--flag`s, with defaults.
   */
  static DEFAULTS = { partition: null, chunks: '8', vdf: 'server', sample: null, testEase: '1', aimAtHeld: false, stubRandomx: false, address: null };

  static parse(argv) {
    const options = { ...CommandLineOptions.DEFAULTS };
    for (let index = 0; index < argv.length; index++) {
      const name = argv[index].replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (!(name in options)) throw new Error(`unknown option ${argv[index]}`);
      if (typeof options[name] === 'boolean') options[name] = true;
      else options[name] = argv[++index];
    }
    if (!options.address) throw new Error('--address is required (the mining address to pack and mine for)');
    return options;
  }
}

class ServerMiner {
  /** The command's entry point: parses `argv`, runs, and reports an error as the exit code. */
  static async main(argv) {
    try {
      await new ServerMiner(CommandLineOptions.parse(argv)).run();
    } catch (error) {
      console.error(`error: ${error.message}`);
      process.exitCode = 1;
    }
  }

  /**
   * Loads a block, holds packed chunks, and mines VDF steps from the chosen source,
   * printing one line per step and stopping at the first solution.
   */
  constructor(options) {
    this.options = options;
    this.gateway = new ArweaveGateway({ log: (message) => console.error(`warn: ${message}`) });
    this.identity = MiningIdentity.fromAddress(options.address);
    this.storage = new HeldStorage();
    this.lastMinedStep = -1;
    if (options.stubRandomx) {
      this.h0Hasher = new StubH0Hasher();
      this.entropySource = new StubEntropySource();
    } else {
      const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../vendor/randomx-arweave/randomx-arweave.iife.js');
      const host = new RandomxDirectHost(RandomxBundle.fromText(readFileSync(bundlePath, 'utf8')));
      this.h0Hasher = new RandomxH0Hasher(host);
      this.entropySource = new RandomxSquaredEntropySource(host);
    }
  }

  async loadBlock() {
    this.block = this.options.sample ? JSON.parse(readFileSync(this.options.sample, 'utf8')) : await this.gateway.currentBlock();
    this.session = VdfSession.fromBlock(this.block);
    this.partitionNumber = Number(this.options.partition ?? this.block.partition_number ?? 0);
  }

  async holdChunks() {
    const filler = new ChunkFiller({
      gateway: this.gateway, identity: this.identity, entropySource: this.entropySource, storage: this.storage,
      onPackProgress: (done, total) => process.stdout.write(`\rpacking: entropy ${done}/${total}`),
      onSkip: (weaveByte, error) => console.error(`chunk at ${weaveByte} failed: ${error.message}`),
      onBatchHeld: ({ count, seconds }) => console.log(`\npacked and held ${count} chunks in ${seconds.toFixed(0)} s`),
    });
    if (this.options.sample) {
      // The saved block's two chunks, from its own proofs.
      await filler.packAndHold(['poa', 'poa2'].map((proof, index) => ({
        bytes: Bytes.fromBase64Url(this.block[proof].unpacked_chunk),
        endOffset: Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[['recall_byte', 'recall_byte2'][index]])),
      })));
      return;
    }
    await filler.fill({ partitionNumber: this.partitionNumber, partitionUpperBound: this.session.partitionUpperBound, wanted: Number(this.options.chunks) });
  }

  makeMiner() {
    return new Miner({
      identity: this.identity, partitionNumber: this.partitionNumber, storage: this.storage, h0Hasher: this.h0Hasher,
      testMode: { aimRange1AtHeldData: this.options.aimAtHeld, difficultyEase: Number(this.options.testEase) },
    });
  }

  /** Mines one step; returns true when a solution was found. */
  async mineStep(stepNumber, output) {
    const report = await this.makeMiner().mineStep(this.session, stepNumber, output);
    this.lastMinedStep = Math.max(this.lastMinedStep, stepNumber);
    console.log(`step ${stepNumber}  h0 ${Bytes.toHex(report.h0).slice(0, 12)}  range1 ${report.range1Start}  range2 ${report.range2Start}  h1 ${report.noncesTried}  h2 ${report.h2Tried}`);
    if (!report.solution) return false;
    console.log(`Solution found! ${report.solution.kind}, nonce ${report.solution.nonce}, hash ${Bytes.toHex(report.solution.hash)}`);
    if (this.options.stubRandomx || Number(this.options.testEase) !== 1 || this.options.aimAtHeld) {
      console.log('(stand-ins or test options were on, so the network would reject it.)');
    }
    return true;
  }

  /** The step source --vdf names (the same ones the page uses: src/mining/step-sources.js). */
  async stepSource() {
    if (this.options.vdf === 'replay' || this.options.sample) return new ReplayStepSource({ steps: this.session.steps(), intervalMs: 0 });
    if (this.options.vdf === 'local') {
      const chain = new VdfChain({ iterationsPerCheckpoint: this.session.vdfDifficulty });
      return new ComputedStepSource({
        start: { stepNumber: this.session.latestStepNumber, output: this.session.stepOutputsNewestFirst[0] },
        // Assumption: reset steps mix in the session's next_seed (ar_nonce_limiter:maybe_add_entropy).
        computeStep: async ({ stepNumber, previousOutput }) => {
          const started = performance.now();
          const checkpoints = chain.computeStep(stepNumber, previousOutput, this.session.nextSeed);
          return { stepNumber, output: checkpoints.at(-1), checkpoints, seconds: (performance.now() - started) / 1000 };
        },
      });
    }
    // Steps from a public VDF server, if any peer or gateway answers GET /vdf.
    const { pool, failures } = await VdfServerPool.connect([...VdfServerClient.PUBLIC_SERVER_URLS, ...ArweaveGateway.DEFAULT_GATEWAY_URLS], { log: (message) => console.error(`warn: ${message}`) });
    if (!pool) throw new Error(`no VDF server answered (${failures.map((failure) => `${failure.url}: ${failure.reason}`).join('; ')}); use --vdf local (slower) instead`);
    console.log(`VDF steps from ${pool.serverUrls.join(', ')}`);
    return new ServerStepSource({
      pool, lastMinedStep: () => this.lastMinedStep, pollIntervalMs: VdfServerClient.POLL_INTERVAL_MS,
      onPoll: ({ newest }) => { this.session = this.session.withVdfUpdate(newest); },
      onError: (error) => console.error(`VDF servers: ${error.message}`),
    });
  }

  async run() {
    await this.loadBlock();
    await this.holdChunks();
    const seconds = SolutionOdds.expectedSecondsPerSolution({ storage: this.storage, partitionNumber: this.partitionNumber, session: this.session });
    console.log(`block ${this.session.height}; holding ${this.storage.byteCount} bytes for ${this.identity.address}; expected wait ${(seconds / 31_557_600).toExponential(2)} years`);
    // Mines until a solution (then stops), or until a replayed source runs out.
    const loop = new StepMiningLoop({
      source: await this.stepSource(),
      mineStep: async (stepNumber, output) => {
        if (await this.mineStep(stepNumber, output)) loop.stop();
      },
    });
    const { ended, error } = await loop.run();
    if (ended === 'failed') throw error;
  }
}

await ServerMiner.main(process.argv.slice(2));
