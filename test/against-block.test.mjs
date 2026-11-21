// Checks src/mining/ against Node's own SHA-256 and a real mainnet block (height 2040257).
// Run: node test/against-block.test.mjs [block.json]   (default: data/sample-block.json)
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Bytes } from '../src/core/bytes.js';
import { Sha256 } from '../src/core/sha256.js';
import { VdfChain, VdfSession } from '../src/mining/vdf.js';
import { Difficulty } from '../src/mining/difficulty.js';
import { Replica29Layout, ChunkPacker } from '../src/mining/packing.js';
import { RepeatedHashEntropySource } from './repeated-hash-entropy.mjs';
import { ConsensusConstants } from '../src/core/constants.js';
import { MiningMath, StubH0Hasher } from '../src/mining/mining-math.js';
import { MiningIdentity } from '../src/mining/identity.js';
import { HeldStorage } from '../src/mining/held-storage.js';
import { Miner } from '../src/mining/miner.js';
import { SolutionOdds } from '../src/mining/odds.js';

class BlockTests {
  constructor(blockPath) {
    this.block = JSON.parse(readFileSync(blockPath, 'utf8'));
    this.failures = 0;
  }

  check(name, passed, detail = '') {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!passed) this.failures++;
  }

  testSha256() {
    const hasher = new Sha256();
    let allMatch = true;
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 8192]) {
      const input = randomBytes(length);
      const expected = createHash('sha256').update(input).digest();
      allMatch &&= Bytes.equal(hasher.digest(new Uint8Array(input)), new Uint8Array(expected));
    }
    const input64 = new Uint8Array(randomBytes(64));
    const expected64 = new Uint8Array(createHash('sha256').update(input64).digest());
    allMatch &&= Bytes.equal(hasher.digest64(input64.slice(), new Uint8Array(32)), expected64);
    this.check('SHA-256 matches node:crypto on assorted lengths and the 64-byte fast path', allMatch);
  }

  /**
   * The VDF at full mainnet difficulty costs about 1.4 s per checkpoint here, 25 per step.
   * Instead of a whole step this checks one real checkpoint against the block (the first,
   * from the previous step's output) and checks how computeStep chains all 25 against an
   * independent implementation at a tiny iteration count, which is the same loop with
   * fewer repetitions.
   */
  testVdfStep() {
    const info = this.block.nonce_limiter_info;
    const stepNumber = Number(info.global_step_number);
    const stepOutputs = info.checkpoints.map(Bytes.fromBase64Url);
    const lastStepCheckpoints = info.last_step_checkpoints.map(Bytes.fromBase64Url); // newest first
    this.check('block checkpoints[0] is the block VDF output', Bytes.equal(stepOutputs[0], Bytes.fromBase64Url(info.output)));
    this.check('the last of last_step_checkpoints is the block VDF output', Bytes.equal(lastStepCheckpoints[0], stepOutputs[0]));

    const chain = new VdfChain({ iterationsPerCheckpoint: Number(info.vdf_difficulty) });
    const firstSalt = VdfChain.saltNumberForStep(stepNumber - 1);
    const started = performance.now();
    const firstCheckpoint = chain.computeCheckpoint(firstSalt, stepOutputs[1]);
    const secondsPerCheckpoint = (performance.now() - started) / 1000;
    this.check('checkpoint 1 of the step, from the previous step\'s output, matches the block', Bytes.equal(firstCheckpoint, lastStepCheckpoints.at(-1)),
      `${secondsPerCheckpoint.toFixed(2)} s per checkpoint (${(Number(info.vdf_difficulty) / secondsPerCheckpoint / 1e6).toFixed(2)} M hashes/s)`);

    const iterations = 3;
    const reference = (step, input, resetSeed) => {
      let value = Buffer.from(input);
      if (resetSeed) value = createHash('sha256').update(value).update(createHash('sha256').update(resetSeed).digest()).digest();
      let salt = VdfChain.saltNumberForStep(step - 1);
      const checkpoints = [];
      for (let index = 0; index < 25; index++, salt++) {
        const saltBytes = Buffer.from(salt.toString(16).padStart(64, '0'), 'hex');
        for (let round = 0; round < iterations; round++) value = createHash('sha256').update(saltBytes).update(value).digest();
        checkpoints.push(new Uint8Array(value));
      }
      return checkpoints;
    };
    const small = new VdfChain({ iterationsPerCheckpoint: iterations });
    const plainStep = small.computeStep(stepNumber, stepOutputs[1]);
    const resetStep = 1200 * 99_937;
    const mixedStep = small.computeStep(resetStep, stepOutputs[1], Bytes.fromBase64Url(info.next_seed));
    this.check('computeStep chains 25 salted checkpoints like an independent implementation',
      plainStep.every((checkpoint, index) => Bytes.equal(checkpoint, reference(stepNumber, stepOutputs[1])[index])));
    this.check('on a reset step, computeStep mixes in the seed first',
      mixedStep.every((checkpoint, index) => Bytes.equal(checkpoint, reference(resetStep, stepOutputs[1], Bytes.fromBase64Url(info.next_seed))[index])));
  }

  testDifficulty() {
    const networkDiff = BigInt(this.block.diff);
    const solutionHash = Bytes.fromBase64Url(this.block.hash);
    const isOneChunk = this.block.recall_byte2 === undefined;
    this.check('block solution hash passes the scaled difficulty', Difficulty.passes(solutionHash, isOneChunk, networkDiff),
      `two-chunk solution: ${!isOneChunk}`);
    console.log(`      per-nonce pass probability: H2 ${Difficulty.passProbability(networkDiff, false).toExponential(4)}, H1 ${Difficulty.passProbability(networkDiff, true).toExponential(4)}`);
  }

  testLayout() {
    const recallByte = BigInt(this.block.recall_byte);
    const partition = recallByte / ConsensusConstants.PARTITION_SIZE;
    this.check('recall_byte lies in the block partition_number', partition === BigInt(this.block.partition_number), `partition ${partition}`);
    const recallByte2 = BigInt(this.block.recall_byte2);
    this.check('recall_byte2 is below the weave upper bound', recallByte2 < BigInt(this.block.nonce_limiter_info.zone_upper_bound));

    const endOffset = Replica29Layout.bucketEndOffsetForByte(recallByte);
    const sliceIndex = Replica29Layout.sliceIndex(endOffset);
    const entropyIndex = Replica29Layout.entropyIndex(endOffset, 0);
    this.check('entropy slice and index are in range', sliceIndex >= 0 && sliceIndex < 1024 && entropyIndex < ConsensusConstants.REPLICA_2_9_ENTROPY_COUNT * 32n,
      `slice ${sliceIndex}, entropy index ${entropyIndex}`);

    const unpacked = Bytes.fromBase64Url(this.block.poa.unpacked_chunk);
    this.check('unpacked_chunk_hash is SHA-256 of poa.unpacked_chunk', Bytes.equal(Sha256.hash(unpacked), Bytes.fromBase64Url(this.block.unpacked_chunk_hash)),
      `${unpacked.length} bytes`);
  }

  async testMiningPipeline() {
    const identity = MiningIdentity.fromAddress(this.block.reward_addr);
    const packer = new ChunkPacker(identity, new RepeatedHashEntropySource());
    const storage = new HeldStorage();
    for (const [chunkField, byteField] of [['poa', 'recall_byte'], ['poa2', 'recall_byte2']]) {
      const endOffset = Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField]));
      storage.add(endOffset, await packer.packChunk(Bytes.fromBase64Url(this.block[chunkField].unpacked_chunk), endOffset));
    }
    const session = VdfSession.fromBlock(this.block);
    const [stepNumber, output] = session.steps().at(-1);

    const honestMiner = new Miner({ identity, partitionNumber: this.block.partition_number, storage, h0Hasher: new StubH0Hasher() });
    const honestReport = await honestMiner.mineStep(session, stepNumber, output);
    this.check('honest step runs; ranges inside the weave', honestReport.range2Start < session.partitionUpperBound,
      `nonces tried ${honestReport.noncesTried}`);

    const testMiner = new Miner({ identity, partitionNumber: this.block.partition_number, storage, h0Hasher: new StubH0Hasher(),
      testMode: { aimRange1AtHeldData: true, difficultyEase: 1e8 } });
    const testReport = await testMiner.mineStep(session, stepNumber, output);
    this.check('test mode reaches the H1 path on held data', testReport.noncesTried > 0, `nonces tried ${testReport.noncesTried}, solution: ${testReport.solution?.kind ?? 'none'}`);

    const seconds = SolutionOdds.expectedSecondsPerSolution({ storage, partitionNumber: this.block.partition_number, session });
    console.log(`      expected wait holding these ${storage.byteCount} bytes: ${(seconds / 31_557_600).toExponential(3)} years`);
  }

  async run() {
    this.testSha256();
    this.testDifficulty();
    this.testLayout();
    await this.testMiningPipeline();
    this.testVdfStep();
    console.log(this.failures === 0 ? 'all checks passed' : `${this.failures} check(s) failed`);
    process.exitCode = this.failures === 0 ? 0 : 1;
  }
}

new BlockTests(process.argv[2] ?? new URL('../data/sample-block.json', import.meta.url)).run();
