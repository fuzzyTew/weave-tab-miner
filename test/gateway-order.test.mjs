// test/gateway-order.test.mjs — ArweaveGateway's source order with a stand-in fetch: peers
// found go first for most requests, but chunk requests try gateways before any node,
// since most nodes do not serve chunks unpacked. Run: node test/gateway-order.test.mjs
import { ArweaveGateway } from '../src/network/gateway.js';
import { TestCase } from './test-case.mjs';

class GatewayOrderTest extends TestCase {
  async run() {
    const asked = [];
    // Every source fails, so the request walks the whole list it was given, in order.
    globalThis.fetch = async (url) => {
      asked.push(new URL(url).origin);
      return new Response('', { status: 404, statusText: 'Not Found' });
    };
    const gateway = new ArweaveGateway({ gatewayUrls: ['https://gateway-a.example', 'https://gateway-b.example'] });
    gateway.preferPeers(['http://node-1.example:1984', 'http://node-2.example:1984']);
    gateway.noteNodes(['http://node-3.example:1984']);
    gateway.preferFirst(['http://node-3.example:1984']);

    await gateway.request('/info').catch(() => {});
    this.report('ordinary requests try chosen sources, then peers, then gateways',
      asked.join() === 'http://node-3.example:1984,http://node-1.example:1984,http://node-2.example:1984,https://gateway-a.example,https://gateway-b.example');

    asked.length = 0;
    await gateway.chunkJson(262144n).catch(() => {});
    this.report('chunk requests try gateways before any node', asked.slice(0, 2).join() === 'https://gateway-a.example,https://gateway-b.example', asked.join());
    this.finish();
  }
}

await new GatewayOrderTest().run();
