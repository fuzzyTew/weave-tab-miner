// test/solana-registry.test.mjs — checks SolanaGatewayRegistry.decodeGateway against gateway
// accounts written by ar.io's own encoder (@ar.io/solana-contracts 4.x), saved in
// test/fixtures/solana-gateway-accounts.json. Run: node test/solana-registry.test.mjs
import { readFileSync } from 'node:fs';
import { SolanaGatewayRegistry } from '../src/network/peers.js';

class SolanaRegistryTest {
  run() {
    const { accounts } = JSON.parse(readFileSync(new URL('./fixtures/solana-gateway-accounts.json', import.meta.url), 'utf8'));
    let failures = 0;
    for (const { expected, base64 } of accounts) {
      const decoded = SolanaGatewayRegistry.decodeGateway(Uint8Array.from(Buffer.from(base64, 'base64')));
      const matches = decoded && Object.entries(expected).every(([field, value]) => decoded[field] === value);
      if (!matches) failures++;
      console.log(`${matches ? 'PASS' : 'FAIL'}  ${expected.fqdn}: ${JSON.stringify(decoded)} → ${decoded ? SolanaGatewayRegistry.urlFor(decoded) : '—'}`);
    }
    const notGateway = SolanaGatewayRegistry.decodeGateway(new Uint8Array(64));
    if (notGateway !== null) failures++;
    console.log(`${notGateway === null ? 'PASS' : 'FAIL'}  other accounts decode to null`);
    process.exitCode = failures ? 1 : 0;
  }
}

new SolanaRegistryTest().run();
