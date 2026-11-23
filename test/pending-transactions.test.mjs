// test/pending-transactions.test.mjs — PendingTransactionPool against a made-up node: headers
// are fetched once and kept, ones no longer pending are dropped, inline format-2 data is
// left out, and a header that fails to fetch is counted, not fatal.
// Run: node test/pending-transactions.test.mjs
import { PendingTransactionPool } from '../src/network/pending-transactions.js';

/** A node whose mempool the test sets, counting header requests. */
class MadeUpNode {
  pending = [];
  headerRequests = 0;

  async get(path) {
    if (path === '/tx/pending') return this.pending;
    const id = path.slice('/unconfirmed_tx/'.length);
    this.headerRequests++;
    if (id === 'gone') throw new Error('HTTP 404');
    return { id, format: 2, data: id === 'inline' ? 'aGVsbG8' : '' };
  }
}

class PendingTransactionsTest {
  constructor() {
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  async run() {
    const node = new MadeUpNode();
    const pool = new PendingTransactionPool({ source: node, concurrency: 2 });
    node.pending = ['a', 'inline', 'gone'];
    const first = await pool.refresh();
    this.report('the first refresh fetches each pending header, counting one that fails', first.fetched === 2 && first.failed === 1 && first.held === 2);
    this.report('inline format-2 data is left out of the header', pool.headersById.get('inline').data === '');

    node.pending = ['b', 'a'];
    const before = node.headerRequests;
    await pool.refresh();
    this.report('a later refresh fetches only new headers and drops ones no longer pending',
      node.headerRequests - before === 1 && !pool.headersById.has('inline') && pool.candidates().map((json) => json.id).join() === 'b,a');

    const [one, two] = await Promise.all([pool.refresh(), pool.refresh()]);
    this.report('refreshes asked for at once share one', one === two);

    const capped = new PendingTransactionPool({ source: node, maxHeld: 1 });
    await capped.refresh();
    this.report('only the first maxHeld pending ids are held', capped.candidates().length === 1 && capped.candidates()[0].id === 'b');
    process.exitCode = this.failures ? 1 : 0;
  }
}

await new PendingTransactionsTest().run();
