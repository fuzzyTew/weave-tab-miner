// test/block-hash.test.mjs — each saved localnet block's id rebuilt from its JSON (the 2.9
// signed-hash preimage, then indep_hash), and its secp256k1 signature checked over the
// signature preimage with the block's own reward key. Fixtures as in
// test/account-tree.test.mjs.
// Run: node test/block-hash.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { BlockHash } from '../src/blocks/hash.js';
import { Bytes } from '../src/core/bytes.js';

class BlockHashTest {
  /** SPKI header for a compressed secp256k1 public key, so Node's crypto can read one. */
  static SECP256K1_SPKI_PREFIX = new Uint8Array(Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex'));

  constructor(fixturesDirectory) {
    this.fixturesDirectory = fixturesDirectory;
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  /** The node signs SHA-256 of the preimage; the signature is r ‖ s ‖ recovery id. */
  static verifiesWithSecp256k1(compressedKey, message, signature) {
    const key = createPublicKey({ key: Buffer.from(Bytes.concat(BlockHashTest.SECP256K1_SPKI_PREFIX, compressedKey)), format: 'der', type: 'spki' });
    return verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature.subarray(0, 64));
  }

  async run() {
    if (!existsSync(this.fixturesDirectory)) {
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    for (const name of readdirSync(this.fixturesDirectory).filter((file) => file.startsWith('block_')).sort()) {
      const { child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const id = Bytes.toBase64Url(await BlockHash.indepHash(child));
      this.report(`block ${child.height}: id from its fields`, id === child.indep_hash, `${id.slice(0, 12)}…`);
      const rewardKey = Bytes.fromBase64Url(child.reward_key);
      const signed = BlockHashTest.verifiesWithSecp256k1(rewardKey, BlockHash.signaturePreimage(child), Bytes.fromBase64Url(child.signature));
      this.report(`block ${child.height}: signature verifies with its reward key`, signed);
      const address = Bytes.toBase64Url(new Uint8Array(createHash('sha256').update(rewardKey).digest()));
      this.report(`block ${child.height}: reward address is SHA-256 of the key`, address === child.reward_addr);
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

new BlockHashTest(process.argv[2] ?? 'localnet_fixtures').run();
