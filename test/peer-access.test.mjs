// test/peer-access.test.mjs — PeerAccess.detectMixedContent: a plain-http address that answers
// means requests get through; none answering (or only https ones offered) means they do not.
// Node never blocks mixed content, so this checks the probing, not a browser's policy.
// Run: node test/peer-access.test.mjs
import { createServer } from 'node:http';
import { PeerAccess } from '../src/network/peers.js';

class PeerAccessTest {
  constructor() {
    this.failures = 0;
  }

  report(name, passed) {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  }

  async run() {
    // A server without CORS headers: no-cors probing must still count its answer.
    const server = createServer((request, response) => response.end('{}'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const answering = `http://127.0.0.1:${server.address().port}/info`;
    const closed = 'http://127.0.0.1:9/info';
    this.report('an answering plain-http address counts as getting through', await PeerAccess.detectMixedContent([closed, answering]));
    this.report('no answering address counts as blocked', !(await PeerAccess.detectMixedContent([closed], { timeoutMs: 2000 })));
    this.report('https addresses are not probes', !(await PeerAccess.detectMixedContent(['https://127.0.0.1:1/info'])));
    server.close();
    process.exitCode = this.failures ? 1 : 0;
  }
}

await new PeerAccessTest().run();
