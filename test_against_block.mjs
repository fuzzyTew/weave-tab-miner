// Checks arweave_miner.js against Node's own SHA-256 and a real mainnet block (height 2040257).
// Run: node test_against_block.mjs <block.json>
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Bytes, Sha256, VdfChain, Difficulty, Replica29Layout, ConsensusConstants, MiningMath,
  MiningIdentity, ChunkPacker, StubEntropySource, StubH0Hasher, HeldStorage, Miner, VdfSession, SolutionOdds,
} from './arweave_miner.js';

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

  testVdfStep() {
    const info = this.block.nonce_limiter_info;
    const stepNumber = Number(info.global_step_number);
    const stepOutputs = info.checkpoints.map(Bytes.fromBase64Url);
    const lastStepCheckpoints = info.last_step_checkpoints.map(Bytes.fromBase64Url);
    this.check('block checkpoints[0] is the block VDF output', Bytes.equal(stepOutputs[0], Bytes.fromBase64Url(info.output)));

    const chain = new VdfChain({ iterationsPerCheckpoint: Number(info.vdf_difficulty) });
    const started = performance.now();
    const firstCheckpoint = chain.computeCheckpoint(VdfChain.saltNumberForStep(stepNumber - 1), stepOutputs[1]);
    const secondsPerCheckpoint = (performance.now() - started) / 1000;
    const position = lastStepCheckpoints.findIndex((checkpoint) => Bytes.equal(checkpoint, firstCheckpoint));
    this.check('first checkpoint of step N, from step N-1 output, appears in last_step_checkpoints', position >= 0,
      `found at index ${position}; ${secondsPerCheckpoint.toFixed(2)} s per checkpoint (${(Number(info.vdf_difficulty) / secondsPerCheckpoint / 1e6).toFixed(2)} M hashes/s)`);

    const fullStep = chain.computeStep(stepNumber, stepOutputs[1]);
    this.check(`full step ${stepNumber} recomputed equals the block's VDF output`, Bytes.equal(fullStep[24], stepOutputs[0]));
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

  testMiningPipeline() {
    const identity = MiningIdentity.fromAddress(this.block.reward_addr);
    const packer = new ChunkPacker(identity, new StubEntropySource());
    const storage = new HeldStorage();
    for (const [chunkField, byteField] of [['poa', 'recall_byte'], ['poa2', 'recall_byte2']]) {
      const endOffset = Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField]));
      storage.add(endOffset, packer.packChunk(Bytes.fromBase64Url(this.block[chunkField].unpacked_chunk), endOffset));
    }
    const session = VdfSession.fromBlock(this.block);
    const [stepNumber, output] = session.steps().at(-1);

    const honestMiner = new Miner({ identity, partitionNumber: this.block.partition_number, storage, h0Hasher: new StubH0Hasher() });
    const honestReport = honestMiner.mineStep(session, stepNumber, output);
    this.check('honest step runs; ranges inside the weave', honestReport.range2Start < session.partitionUpperBound,
      `nonces tried ${honestReport.noncesTried}`);

    const testMiner = new Miner({ identity, partitionNumber: this.block.partition_number, storage, h0Hasher: new StubH0Hasher(),
      testMode: { aimRange1AtHeldData: true, difficultyEase: 1e8 } });
    const testReport = testMiner.mineStep(session, stepNumber, output);
    this.check('test mode reaches the H1 path on held data', testReport.noncesTried > 0, `nonces tried ${testReport.noncesTried}, solution: ${testReport.solution?.kind ?? 'none'}`);

    const seconds = SolutionOdds.expectedSecondsPerSolution({ storage, partitionNumber: this.block.partition_number, session });
    console.log(`      expected wait holding these ${storage.byteCount} bytes: ${(seconds / 31_557_600).toExponential(3)} years`);
  }

  run() {
    this.testSha256();
    this.testDifficulty();
    this.testLayout();
    this.testMiningPipeline();
    this.testVdfStep();
    console.log(this.failures === 0 ? 'all checks passed' : `${this.failures} check(s) failed`);
    process.exitCode = this.failures === 0 ? 0 : 1;
  }
}

new BlockTests(process.argv[2]).run();
