// test/block-signer.test.mjs — BlockSigner on a saved localnet block re-signed with a fresh
// RSA key: the signature verifies over the 2.9 signature preimage, the id recomputes, the
// same block may be signed again, and a competing block is refused. Fixtures as in
// test/account-tree.test.mjs.
// Run: node test/block-signer.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { BlockSigner } from '../src/blocks/signer.js';
import { BlockHash } from '../src/blocks/hash.js';
import { DoubleSigningGuard, MemoryStorage } from '../src/blocks/signing-guard.js';
import { ArweaveWallet } from '../src/wallet/wallet.js';
import { Bytes } from '../src/core/bytes.js';

class BlockSignerTest {
  constructor(fixturesDirectory) {
    this.fixturesDirectory = fixturesDirectory;
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  async run() {
    if (!existsSync(this.fixturesDirectory)) {
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    const name = readdirSync(this.fixturesDirectory).filter((file) => file.startsWith('block_')).sort()[0];
    const { child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
    const wallet = await ArweaveWallet.generate();
    const signer = new BlockSigner({ wallet, guard: new DoubleSigningGuard({ storage: new MemoryStorage() }) });

    const signed = await signer.sign(child);
    const publicKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', e: 'AQAB', n: signed.reward_key }, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify']);
    const verifies = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, publicKey, Bytes.fromBase64Url(signed.signature), BlockHash.signaturePreimage(signed));
    this.report('the RSA signature verifies over the signature preimage', verifies, `${Bytes.fromBase64Url(signed.signature).length}-byte signature`);
    this.report('the id recomputes from the signed block', Bytes.toBase64Url(await BlockHash.indepHash(signed)) === signed.indep_hash);
    this.report('the reward address is the key\'s', signed.reward_addr === wallet.address);

    const again = await signer.sign(child).then(() => 'signed', (error) => error.message);
    this.report('the same block may be signed again', again === 'signed', again);
    const rival = await signer.sign({ ...child, nonce: 'Ag' }).then(() => 'signed', (error) => error.message);
    this.report('a competing block is refused', /refusing to sign/.test(rival), rival.slice(0, 90));
    const next = { ...child, height: child.height + 1, previous_cumulative_diff: child.cumulative_diff, cumulative_diff: (BigInt(child.cumulative_diff) + 1n).toString() };
    const onTop = await signer.sign(next).then(() => 'signed', (error) => error.message);
    this.report('the next block, built on it, is allowed', onTop === 'signed', onTop);
    const guard = signer.guard;
    this.report('the guard names the block signed on a parent, so a sibling need not be built',
      guard.signedChildOf(wallet.address, BigInt(signed.previous_cumulative_diff))?.height === signed.height
      && guard.signedChildOf(wallet.address, BigInt(signed.previous_cumulative_diff) + 12345n) === null);
    process.exitCode = this.failures ? 1 : 0;
  }
}

new BlockSignerTest(process.argv[2] ?? 'localnet_fixtures').run();
