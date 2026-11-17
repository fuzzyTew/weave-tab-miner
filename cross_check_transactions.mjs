// Cross-checks the browser node's wallet and transaction code against arweave-js 1.15.5.
// Run: node cross_check_transactions.mjs <path to browser-node directory>
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Arweave = require('arweave');
const arweaveMerkle = require('arweave/node/lib/merkle');

class TransactionCrossCheck {
  constructor(browserNodeDirectory) {
    this.moduleUrl = (name) => pathToFileURL(path.join(browserNodeDirectory, name)).href;
    this.arweave = Arweave.init({});
    this.failures = 0;
  }

  check(name, passed, detail = '') {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!passed) this.failures++;
  }

  async run() {
    const { Bytes } = await import(this.moduleUrl('arweave_miner.js'));
    const { ArweaveWallet } = await import(this.moduleUrl('arweave_wallet.js'));
    const { DataMerkle, DataTransaction } = await import(this.moduleUrl('arweave_transaction.js'));

    // The 256 KiB + 100 size forces the even split of the last two chunks.
    for (const size of [1, 1000, 262144, 262244, 600000, 786432, 1048576 + 5]) {
      const data = new Uint8Array(randomBytes(size));
      const expected = await arweaveMerkle.computeRootHash(data);
      this.check(`data_root for ${size} bytes matches arweave-js`, Bytes.equal(DataMerkle.root(data), new Uint8Array(expected)));
    }

    const jwk = await this.arweave.wallets.generate();
    const wallet = await ArweaveWallet.fromJwk(jwk);
    this.check('address from a keyfile matches arweave-js', wallet.address === await this.arweave.wallets.jwkToAddress(jwk), wallet.address);

    const data = new TextEncoder().encode('a small permanent record');
    const anchor = Bytes.toBase64Url(new Uint8Array(randomBytes(48)));
    const tags = [['Content-Type', 'text/plain'], ['App-Name', 'Weave-Tab-Miner']];
    const ours = new DataTransaction({ data, tags, anchor, rewardWinston: 12345678n });

    const theirs = await this.arweave.createTransaction({ data, last_tx: anchor, reward: '12345678' }, jwk);
    for (const [name, value] of tags) theirs.addTag(name, value);
    const theirSignatureData = await theirs.getSignatureData();
    const ourSignatureData = await ours.signatureData(wallet.ownerBytes);
    this.check('signature data (deep hash) matches arweave-js', Bytes.equal(ourSignatureData, new Uint8Array(theirSignatureData)));

    await ours.sign(wallet);
    const ourJson = ours.toJson();
    const reloaded = this.arweave.transactions.fromRaw({ ...ourJson });
    this.check('arweave-js verifies our signed transaction', await this.arweave.transactions.verify(reloaded), `id ${ours.id}`);
    this.check('our JSON id equals arweave-js id rule', ourJson.id === Bytes.toBase64Url(new Uint8Array(await this.arweave.crypto.hash(Bytes.fromBase64Url(ourJson.signature)))));

    const generated = await ArweaveWallet.generate();
    const exported = await generated.exportJwk();
    this.check('generated wallet exports a keyfile arweave-js accepts', await this.arweave.wallets.jwkToAddress(exported) === generated.address, generated.address);

    console.log(this.failures === 0 ? 'all checks passed' : `${this.failures} check(s) failed`);
    process.exitCode = this.failures === 0 ? 0 : 1;
  }
}

new TransactionCrossCheck(process.argv[2]).run();
