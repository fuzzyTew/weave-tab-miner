// node_miner.mjs — server mode: the same mining library as the page, run from Node 18+.
//
//   node node_miner.mjs --address <43-char address> [--partition 62] [--chunks 16]
//                       [--vdf follow|local|replay] [--sample sample_block.json]
//                       [--test-ease 1000000000] [--aim-at-held]
//
// --sample uses a saved block (and its two chunks) instead of the network.
import { readFileSync } from 'node:fs';
import {
  Bytes, ConsensusConstants, Replica29Layout, MiningIdentity, ChunkPacker, StubEntropySource,
  StubH0Hasher, HeldStorage, Miner, VdfSession, VdfChain, SolutionOdds,
} from './arweave_miner.js';
import { ArweaveGateway } from './arweave_gateway.js';

class CommandLineOptions {
  /**
   * `--name value` pairs and bare `--flag`s, with defaults.
   */
  static DEFAULTS = { partition: null, chunks: '8', vdf: 'follow', sample: null, testEase: '1', aimAtHeld: false, address: null };

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
  /**
   * Loads a block, holds packed chunks, and mines VDF steps from the chosen source,
   * printing one line per step and stopping at the first solution.
   */
  static FOLLOW_POLL_INTERVAL_MS = 60_000;

  constructor(options) {
    this.options = options;
    this.gateway = new ArweaveGateway({ log: (message) => console.error(`warn: ${message}`) });
    this.identity = MiningIdentity.fromAddress(options.address);
    this.storage = new HeldStorage();
    this.lastMinedStep = -1;
  }

  async loadBlock() {
    this.block = this.options.sample ? JSON.parse(readFileSync(this.options.sample, 'utf8')) : await this.gateway.currentBlock();
    this.session = VdfSession.fromBlock(this.block);
    this.partitionNumber = Number(this.options.partition ?? this.block.partition_number ?? 0);
  }

  async holdChunks() {
    const packer = new ChunkPacker(this.identity, new StubEntropySource());
    if (this.options.sample) {
      for (const [chunkField, byteField] of [['poa', 'recall_byte'], ['poa2', 'recall_byte2']]) {
        const endOffset = Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField]));
        this.storage.add(endOffset, packer.packChunk(Bytes.fromBase64Url(this.block[chunkField].unpacked_chunk), endOffset));
      }
      return;
    }
    const partitionStart = BigInt(this.partitionNumber) * ConsensusConstants.PARTITION_SIZE;
    const windowSize = Number(ConsensusConstants.PARTITION_SIZE);
    for (let index = 0; index < Number(this.options.chunks); index++) {
      const weaveByte = partitionStart + BigInt(Math.floor(Math.random() * windowSize));
      try {
        const chunk = Bytes.fromBase64Url((await this.gateway.chunkJson(weaveByte)).chunk);
        const endOffset = Replica29Layout.bucketEndOffsetForByte(weaveByte);
        this.storage.add(endOffset, packer.packChunk(chunk, endOffset));
        console.log(`packed ${chunk.length} bytes at weave byte ${weaveByte}`);
      } catch (error) {
        console.error(`chunk at ${weaveByte} failed: ${error.message}`);
      }
    }
  }

  makeMiner() {
    return new Miner({
      identity: this.identity, partitionNumber: this.partitionNumber, storage: this.storage, h0Hasher: new StubH0Hasher(),
      testMode: { aimRange1AtHeldData: this.options.aimAtHeld, difficultyEase: Number(this.options.testEase) },
    });
  }

  /** Returns true when a solution was found. */
  mineStep(stepNumber, output) {
    const report = this.makeMiner().mineStep(this.session, stepNumber, output);
    this.lastMinedStep = Math.max(this.lastMinedStep, stepNumber);
    console.log(`step ${stepNumber}  h0 ${Bytes.toHex(report.h0).slice(0, 12)}  range1 ${report.range1Start}  range2 ${report.range2Start}  h1 ${report.noncesTried}  h2 ${report.h2Tried}`);
    if (!report.solution) return false;
    console.log(`Solution found! ${report.solution.kind}, nonce ${report.solution.nonce}, hash ${Bytes.toHex(report.solution.hash)}`);
    console.log('(H0 and packing are stand-ins, and test options may be on, so the network would reject it.)');
    return true;
  }

  async mineFollowing() {
    for (;;) {
      for (const [stepNumber, output] of this.session.steps(this.lastMinedStep)) if (this.mineStep(stepNumber, output)) return;
      await new Promise((resolve) => setTimeout(resolve, ServerMiner.FOLLOW_POLL_INTERVAL_MS));
      try {
        await this.loadBlock();
      } catch (error) {
        console.error(`could not refresh the block: ${error.message}`);
      }
    }
  }

  mineLocalVdf() {
    const chain = new VdfChain({ iterationsPerCheckpoint: this.session.vdfDifficulty });
    let stepNumber = this.session.latestStepNumber;
    let output = this.session.stepOutputsNewestFirst[0];
    for (;;) {
      stepNumber += 1;
      // Assumption: reset steps mix in the session's next_seed (ar_nonce_limiter:maybe_add_entropy).
      output = chain.computeStep(stepNumber, output, this.session.nextSeed).at(-1);
      if (this.mineStep(stepNumber, output)) return;
    }
  }

  async run() {
    await this.loadBlock();
    await this.holdChunks();
    const seconds = SolutionOdds.expectedSecondsPerSolution({ storage: this.storage, partitionNumber: this.partitionNumber, session: this.session });
    console.log(`block ${this.session.height}; holding ${this.storage.byteCount} bytes for ${this.identity.address}; expected wait ${(seconds / 31_557_600).toExponential(2)} years`);
    if (this.options.vdf === 'local') this.mineLocalVdf();
    else if (this.options.vdf === 'replay' || this.options.sample) {
      for (const [stepNumber, output] of this.session.steps()) if (this.mineStep(stepNumber, output)) return;
    } else await this.mineFollowing();
  }
}

try {
  await new ServerMiner(CommandLineOptions.parse(process.argv.slice(2))).run();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
