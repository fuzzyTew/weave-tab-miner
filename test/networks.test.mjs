// test/networks.test.mjs — RecordMirror over the storage networks, with a fake gateway and
// a fake Turbo: prices compare, a record is stored on each reachable network and verifies,
// and a network needing a missing transport reports what it needs without stopping the
// others. Run: node test/networks.test.mjs
import { ArweaveTransactionNetwork, AutonomiNetwork, RecordMirror, TurboNetwork } from '../src/networks.js';
import { DataItem } from '../src/bundle.js';
import { ArweaveWallet } from '../src/wallet.js';

class FakeGateway {
  /** Answers price and anchor; keeps what was posted. */
  lastAnsweredBy = 'https://gateway.example';
  posted = [];
  async priceWinston(byteCount) { return BigInt(byteCount) * 1000n; }
  async transactionAnchor() { return 'A'.repeat(43); }
  async postTransaction(json) { this.posted.push(json); return 'OK'; }
}

class FakeUploader {
  /** Accepts any item for free, like Turbo's free tier; keeps the bytes. */
  uploaded = [];
  async upload(item) { this.uploaded.push(item.toBytes()); return { id: item.id, winc: '0' }; }
}

class NetworksTest {
  async run() {
    let failures = 0;
    const report = (name, passed, detail = '') => {
      if (!passed) failures++;
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    };
    const gateway = new FakeGateway();
    const uploader = new FakeUploader();
    const mirror = new RecordMirror([new ArweaveTransactionNetwork({ gateway }), new TurboNetwork({ uploader }), new AutonomiNetwork()]);

    const quotes = await mirror.compare(1000);
    report('prices compare', quotes[0].cost === '0.00000100 AR' && quotes[1].free && !quotes[2].available, quotes.map((quote) => `${quote.network.name}: ${quote.cost ?? quote.note}`).join('; '));
    const big = await mirror.compare(200 * 1024);
    report('Turbo says when a record is past its free size', !big[1].available, big[1].note);

    const wallet = await ArweaveWallet.generate();
    const data = new TextEncoder().encode('a record kept in two places');
    const results = await mirror.storeEverywhere({ data, tags: [['Content-Type', 'text/plain']], wallet });
    report('stored on both reachable networks', results[0].ok && results[1].ok, results.map((result) => `${result.network.name}: ${result.ok ? result.id.slice(0, 8) : result.note}`).join('; '));
    report('the missing transport is reported, not thrown', !results[2].ok && /libp2p/.test(results[2].note), results[2].note);
    report('the gateway got a signed transaction', gateway.posted.length === 1 && gateway.posted[0].signature.length > 600);
    const item = await DataItem.parseAndVerify(uploader.uploaded[0]);
    report('the Turbo item verifies and carries the record', item.valid && new TextDecoder().decode(item.data) === 'a record kept in two places');
    process.exitCode = failures ? 1 : 0;
  }
}

new NetworksTest().run();
