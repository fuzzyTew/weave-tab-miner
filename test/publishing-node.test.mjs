// test/publishing-node.test.mjs — PublishingNode's lifecycle with stand-ins (no network):
// resuming a saved state, refusing one too far behind, losing the chain on a block that
// does not follow, and declining to publish before it is ready. The block building itself
// is tested by block-publisher's tests. Run: node test/publishing-node.test.mjs
import { PublishingNode } from '../src/network/publishing-node.js';
import { MemoryStorage } from '../src/blocks/signing-guard.js';
import { TestCase } from './test-case.mjs';

class PublishingNodeTest extends TestCase {
  /** A PublishingNode whose store holds `savedState`, and the statuses and log it gave. */
  static node({ savedState = null, gatewayRequest = async () => { throw new Error('no network in this test'); } } = {}) {
    const heard = { statuses: [], logs: [] };
    const node = new PublishingNode({
      gateway: { request: gatewayRequest, chunkJson: async () => null },
      chainStateStore: { load: async () => savedState, save: async () => true },
      rules: {}, signingGuardStorage: new MemoryStorage(),
      log: (message, level) => heard.logs.push(`${level ?? 'info'}: ${message}`),
      onStatus: (text) => heard.statuses.push(text),
    });
    return { node, heard };
  }

  async run() {
    // Reading accounts goes through NodeClient's fetch: no node answers here.
    globalThis.fetch = async (url) => { throw new TypeError(`no network in this test (${url})`); };
    const tip = { height: '100', indep_hash: 'tip-hash' };
    const nodeUrls = ['http://node-a:1984', 'http://node-b:1984'];

    const resumed = PublishingNodeTest.node({ savedState: { block: { height: '100', indep_hash: 'tip-hash' } } });
    this.report('a saved state at the tip resumes without reading accounts', await resumed.node.prepare(tip, nodeUrls) && resumed.node.ready);
    this.report('it posts to the given nodes', resumed.node.publishNodes.length === 2);
    this.report('the status says ready', resumed.heard.statuses.at(-1).startsWith('Ready to publish'), resumed.heard.statuses.at(-1));

    const stale = PublishingNodeTest.node({ savedState: { block: { height: '1' } } });
    const farTip = { height: '1000', indep_hash: 'far-tip' };
    this.report('a state too far behind is not resumed, and with no node answering nothing is ready',
      !(await stale.node.prepare(farTip, nodeUrls)) && !stale.node.ready && stale.heard.logs.some((line) => line.includes('999 blocks behind')), stale.heard.logs.join(' | '));
    this.report('each node that failed is logged with its cause', stale.heard.logs.filter((line) => line.startsWith('warn: could not get chain state from')).length === 2);

    // The next block names another parent, so it does not follow: the state is dropped.
    const forked = PublishingNodeTest.node({ savedState: { block: { height: '100', indep_hash: 'tip-hash' } } });
    await forked.node.prepare(tip, nodeUrls);
    const followed = await forked.node.followToTip({ height: '101', indep_hash: 'next', previous_block: 'another-parent' });
    this.report('a block on another parent drops the state for the caller to prepare again', !followed && !forked.node.ready);

    const unready = PublishingNodeTest.node();
    this.report('publishing before the state is ready declines', (await unready.node.publish({ stepNumber: 1 }, {})) === null && unready.heard.logs.at(-1).includes('not ready'));

    const wallet = { kty: 'RSA' };
    this.report('the signer is kept for the same wallet', unready.node.signerFor(wallet) === unready.node.signerFor(wallet) && unready.node.signerFor({}) !== unready.node.signerFor(wallet));

    const concurrent = PublishingNodeTest.node({ savedState: { block: { height: '100', indep_hash: 'tip-hash' } } });
    const [first, second] = await Promise.all([concurrent.node.prepare(tip, nodeUrls), concurrent.node.prepare(tip, nodeUrls)]);
    this.report('a second prepare while one runs resolves false at once', first && !second);
    this.finish();
  }
}

await new PublishingNodeTest().run();
