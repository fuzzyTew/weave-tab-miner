// test/gateway-order.test.mjs — ArweaveGateway's source order with a stand-in fetch: peers
// found go first for most requests, and chunk requests rank sources by what they have
// served, so a source that serves rises and one that fails drops back, node or gateway.
// Run: node test/gateway-order.test.mjs
import { ArweaveGateway } from '../src/network/gateway.js';
import { SourceRecord } from '../src/network/source-record.js';
import { TestCase } from './test-case.mjs';

class GatewayOrderTest extends TestCase {
  async run() {
    const asked = [];
    // Only node-2 has chunks; everything else answers 404.
    globalThis.fetch = async (url) => {
      asked.push(new URL(url).origin);
      const serves = url.startsWith('http://node-2.example:1984/chunk/');
      return new Response(serves ? '{"chunk":""}' : '', { status: serves ? 200 : 404, statusText: serves ? 'OK' : 'Not Found' });
    };
    const gateway = new ArweaveGateway({ gatewayUrls: ['https://gateway-a.example', 'https://gateway-b.example'] });
    gateway.preferPeers(['http://node-1.example:1984', 'http://node-2.example:1984']);
    gateway.preferFirst(['http://node-3.example:1984']);

    await gateway.request('/info').catch(() => {});
    this.report('ordinary requests try chosen sources, then peers, then gateways',
      asked.join() === 'http://node-3.example:1984,http://node-1.example:1984,http://node-2.example:1984,https://gateway-a.example,https://gateway-b.example');

    asked.length = 0;
    await gateway.chunkJson(262144n);
    this.report('the first chunk walks the order until node-2 serves', asked.join() === 'http://node-3.example:1984,http://node-1.example:1984,http://node-2.example:1984', asked.join());

    asked.length = 0;
    await gateway.chunkJson(524288n);
    this.report('the next chunk asks node-2 first', asked.join() === 'http://node-2.example:1984', asked.join());

    // Untried sources rank above failed ones, so ones not yet asked still get a turn.
    const ranked = gateway.chunkSources.ranked(gateway.gatewayUrls);
    this.report('untried gateways rank above failed nodes', ranked.indexOf('https://gateway-a.example') < ranked.indexOf('http://node-3.example:1984'), ranked.join());
    this.report('the summary names each source tried', gateway.chunkSources.summary() === 'node-2.example:1984 2 of 2, node-3.example:1984 0 of 1, node-1.example:1984 0 of 1', gateway.chunkSources.summary());

    const record = new SourceRecord();
    this.report('equal scores keep their given order', record.ranked(['b', 'a', 'c']).join() === 'b,a,c');
    this.finish();
  }
}

await new GatewayOrderTest().run();
