// test/block-verifier.test.mjs — BlockVerifier on real blocks: mainnet's (RSA keys) and a
// localnet's (secp256k1 keys, from the localnet-fixtures branch) check out, and a block
// with a changed field or signature does not. Run: node test/block-verifier.test.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { BlockVerifier } from '../src/blocks/block-verifier.js';
import { BlockHash } from '../src/blocks/hash.js';
import { TestCase } from './test-case.mjs';

class BlockVerifierTest extends TestCase {
  constructor({ mainnetDirectory = 'mainnet_fixtures', localnetDirectory = 'localnet_fixtures' } = {}) {
    super();
    Object.assign(this, { mainnetDirectory, localnetDirectory });
  }


  /** The captured blocks of each kind present, or [] (the fixtures live on their own branches). */
  blocks() {
    const mainnetFile = `${this.mainnetDirectory}/blocks.json.gz`;
    const mainnet = existsSync(mainnetFile) ? JSON.parse(gunzipSync(readFileSync(mainnetFile))).map((entry) => entry.block) : [];
    const localnet = existsSync(this.localnetDirectory)
      ? readdirSync(this.localnetDirectory).filter((name) => name.startsWith('block_')).map((name) => JSON.parse(readFileSync(`${this.localnetDirectory}/${name}`, 'utf8')).child)
      : [];
    return { mainnet, localnet };
  }

  async run() {
    const { mainnet, localnet } = this.blocks();
    if (!mainnet.length && !localnet.length) return console.log('SKIP  no captured blocks here');
    for (const [kind, blocks] of [['mainnet (RSA)', mainnet], ['localnet (secp256k1)', localnet]]) {
      if (!blocks.length) continue;
      const problems = await Promise.all(blocks.map((block) => BlockVerifier.problem(block)));
      this.report(`${blocks.length} ${kind} blocks are genuine`, problems.every((problem) => problem === null), problems.find(Boolean) ?? '');
    }
    const sample = mainnet[0] ?? localnet[0];
    const changedField = await BlockVerifier.problem({ ...sample, reward: '1' });
    this.report('a block with a changed field is caught by its id', /is not the hash/.test(changedField ?? ''), changedField ?? '');
    // A forged signature with a matching id: the id is recomputed from it, so only the key check can catch it.
    const signature = Buffer.from(sample.signature, 'base64url');
    signature[10] ^= 1;
    const forged = { ...sample, signature: signature.toString('base64url') };
    forged.indep_hash = Buffer.from(await BlockHash.indepHash(forged)).toString('base64url');
    const badSignature = await BlockVerifier.problem(forged);
    this.report('a block re-hashed around a changed signature is caught by its key', /signature/.test(badSignature ?? ''), badSignature ?? '');
    this.finish();
  }
}

await new BlockVerifierTest().run();
