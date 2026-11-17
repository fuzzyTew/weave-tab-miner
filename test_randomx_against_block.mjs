// Checks real H0, real packing and the whole mining step against mainnet block 2,040,257,
// using the vendored randomx.js build for Arweave. Run: node test_randomx_against_block.mjs
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Bytes, Sha256, ConsensusConstants, Replica29Layout, MiningIdentity, ChunkPacker, HeldStorage, Miner, VdfSession,
} from './arweave_miner.js';
import { RandomxDirectHost, RandomxH0Hasher, RandomxSquaredEntropySource } from './arweave_randomx.js';

class RandomxBlockTests {
  constructor(directory) {
    this.directory = directory;
    this.block = JSON.parse(readFileSync(join(directory, 'sample_block.json'), 'utf8'));
    this.failures = 0;
  }

  check(name, passed, detail = '') {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!passed) this.failures++;
  }

  loadRandomx() {
    // The bundle is a classic script defining RandomxArweave; evaluate it as the browser would.
    runInThisContext(readFileSync(join(this.directory, 'vendor/randomx-arweave/randomx-arweave.iife.js'), 'utf8') + '\nglobalThis.RandomxArweave = RandomxArweave;');
    const started = performance.now();
    const host = new RandomxDirectHost(globalThis.RandomxArweave);
    console.log(`      RandomX cache built in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return host;
  }

  get nonce() {
    return Number(Bytes.toBigInt(Bytes.fromBase64Url(this.block.nonce)));
  }

  async testPacking(packer) {
    const subChunkIndex = this.nonce % ConsensusConstants.SUB_CHUNK_COUNT;
    const size = ConsensusConstants.SUB_CHUNK_SIZE;
    for (const [proof, byteField] of [['poa', 'recall_byte'], ['poa2', 'recall_byte2']]) {
      const endOffset = Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField]));
      const started = performance.now();
      const packed = await packer.packChunk(Bytes.fromBase64Url(this.block[proof].unpacked_chunk), endOffset);
      const seconds = (performance.now() - started) / 1000;
      const expected = Bytes.fromBase64Url(this.block[proof].chunk);
      this.check(`${proof}: packing the unpacked chunk reproduces the block's packed sub-chunk ${subChunkIndex}`,
        Bytes.equal(packed.subarray(subChunkIndex * size, (subChunkIndex + 1) * size), expected), `32 entropies in ${seconds.toFixed(1)} s`);
    }
  }

  async testMiningStep(identity, h0Hasher) {
    const subChunkIndex = this.nonce % ConsensusConstants.SUB_CHUNK_COUNT;
    const size = ConsensusConstants.SUB_CHUNK_SIZE;
    // Hold each recall chunk with only the proven packed sub-chunk filled in.
    const storage = new HeldStorage();
    for (const [proof, byteField] of [['poa', 'recall_byte'], ['poa2', 'recall_byte2']]) {
      const packedChunk = new Uint8Array(ConsensusConstants.DATA_CHUNK_SIZE);
      packedChunk.set(Bytes.fromBase64Url(this.block[proof].chunk), subChunkIndex * size);
      storage.add(Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField])), packedChunk);
    }

    const session = VdfSession.fromBlock(this.block);
    const miner = new Miner({ identity, partitionNumber: Number(this.block.partition_number), storage, h0Hasher });
    const report = await miner.mineStep(session, session.latestStepNumber, Bytes.fromBase64Url(this.block.nonce_limiter_info.output));

    const [recallByte1] = [report.trace.firstHeldNonce?.recallByte1];
    this.check('H0 places recall range 1 so that nonce lands on the block recall_byte', recallByte1 !== undefined
      && Replica29Layout.bucketEndOffsetForByte(recallByte1) === Replica29Layout.bucketEndOffsetForByte(BigInt(this.block.recall_byte)));
    this.check('the miner finds the block\'s own solution', report.solution?.nonce === this.nonce && Bytes.equal(report.solution.hash, Bytes.fromBase64Url(this.block.hash)),
      report.solution ? `${report.solution.kind} at nonce ${report.solution.nonce}` : 'no solution');
    const h2 = report.trace.firstHeldNonce?.h2;
    this.check('H2 preimage equals the block hash_preimage', Boolean(h2) && report.solution?.nonce === this.nonce
      && Bytes.equal(Sha256.hash(report.h0, Bytes.fromBase64Url(this.block.hash_preimage)), Bytes.fromBase64Url(this.block.hash)));
  }

  async run() {
    const host = this.loadRandomx();
    const identity = MiningIdentity.fromAddress(this.block.reward_addr);
    await this.testMiningStep(identity, new RandomxH0Hasher(host));
    await this.testPacking(new ChunkPacker(identity, new RandomxSquaredEntropySource(host)));
    console.log(this.failures === 0 ? 'all checks passed' : `${this.failures} check(s) failed`);
    process.exitCode = this.failures === 0 ? 0 : 1;
  }
}

new RandomxBlockTests(dirname(fileURLToPath(import.meta.url))).run();
