// test/block-solution.test.mjs — BlockSolution against the saved localnet blocks: from a
// block's unpacked chunks, recall bytes, nonce and VDF info, our packing, H0 (real RandomX),
// H1 and (for two-chunk blocks) H2 must give the node's solution fields. The localnet leaves
// hash_preimage as zeros, so that field is not compared.
// Fixtures as in test/account-tree.test.mjs.
// Run: node test/block-solution.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { BlockSolution } from '../src/blocks/solution.js';
import { RandomxDirectHost, RandomxH0Hasher, RandomxSquaredEntropySource } from '../src/mining/randomx.js';
import { Bytes } from '../src/core/bytes.js';
import { MiningIdentity } from '../src/mining/identity.js';

class BlockSolutionTest {
  static COMPARED_FIELDS = ['nonce', 'hash', 'recall_byte', 'partition_number', 'poa', 'chunk_hash', 'unpacked_chunk_hash', 'packing_difficulty', 'replica_format'];
  static TWO_CHUNK_FIELDS = ['recall_byte2', 'poa2', 'chunk2_hash', 'unpacked_chunk2_hash'];

  constructor(fixturesDirectory) {
    this.fixturesDirectory = fixturesDirectory;
    this.failures = 0;
  }

  async run() {
    if (!existsSync(this.fixturesDirectory)) {
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    // The RandomX bundle is a classic script defining RandomxArweave; evaluate it as a page would.
    runInThisContext(readFileSync(new URL('../vendor/randomx-arweave/randomx-arweave.iife.js', import.meta.url), 'utf8') + '\nglobalThis.RandomxArweave = RandomxArweave;');
    const host = new RandomxDirectHost(globalThis.RandomxArweave);
    const h0Hasher = new RandomxH0Hasher(host);
    const entropySource = new RandomxSquaredEntropySource(host);
    for (const name of readdirSync(this.fixturesDirectory).filter((file) => file.startsWith('block_')).sort()) {
      const { parent, child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const twoChunks = child.recall_byte2 !== undefined && child.recall_byte2 !== null;
      const compared = twoChunks ? [...BlockSolutionTest.COMPARED_FIELDS, ...BlockSolutionTest.TWO_CHUNK_FIELDS] : BlockSolutionTest.COMPARED_FIELDS;
      // The block holds the chunk zero-padded to 256 KiB; GET /chunk serves a small chunk
      // without the padding, so the chunk is also tried with trailing zeros cut off.
      const padded = Bytes.fromBase64Url(child.poa.unpacked_chunk);
      let dataLength = padded.length;
      while (dataLength && !padded[dataLength - 1]) dataLength--;
      const chunks = { 'padded chunk': padded, ...(dataLength < padded.length ? { [`${dataLength}-byte chunk as served`]: padded.subarray(0, dataLength) } : {}) };
      for (const [chunkName, chunk] of Object.entries(chunks)) {
        const solution = await BlockSolution.build({
          addressBytes: MiningIdentity.fromAddress(child.reward_addr).addressBytes,
          vdfInfo: child.nonce_limiter_info, seed: Bytes.fromBase64Url(parent.block.nonce_limiter_info.seed),
          recallByte: BigInt(child.recall_byte), nonce: Number(Bytes.toBigInt(Bytes.fromBase64Url(child.nonce))),
          chunkJson: { chunk: Bytes.toBase64Url(chunk), data_path: child.poa.data_path, tx_path: child.poa.tx_path },
          ...(twoChunks ? { recallByte2: BigInt(child.recall_byte2), chunk2Json: { chunk: child.poa2.unpacked_chunk, data_path: child.poa2.data_path, tx_path: child.poa2.tx_path } } : {}),
          h0Hasher, entropySource,
        });
        const differing = compared.filter((field) => JSON.stringify(solution[field]) !== JSON.stringify(child[field]));
        if (differing.length) this.failures++;
        console.log(`${differing.length ? 'FAIL' : 'PASS'}  block ${child.height}, ${chunkName}: ${twoChunks ? 'two' : 'one'}-chunk solution fields match the node's${differing.length ? ' — differ: ' + differing.join(', ') : ''}`);
      }
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

new BlockSolutionTest(process.argv[2] ?? 'localnet_fixtures').run();
