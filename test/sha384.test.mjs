// test/sha384.test.mjs — Sha384 against Node's crypto on lengths around the 128-byte block and
// padding edges, and random data; then its speed on account-sized inputs.
// Run: node test/sha384.test.mjs
import { createHash, randomBytes } from 'node:crypto';
import { Sha384 } from '../src/core/sha384.js';

class Sha384Test {
  run() {
    let failures = 0;
    for (const length of [0, 1, 3, 55, 56, 64, 111, 112, 113, 127, 128, 129, 200, 255, 256, 1000, 100000]) {
      const input = new Uint8Array(randomBytes(length));
      const ours = Buffer.from(Sha384.hash(input)).toString('hex');
      const node = createHash('sha384').update(input).digest('hex');
      if (ours !== node) {
        failures++;
        console.log(`FAIL  ${length} bytes: ${ours} vs ${node}`);
      }
    }
    console.log(`${failures ? 'FAIL' : 'PASS'}  SHA-384 matches node:crypto on 17 lengths, padding edges included`);
    const input = new Uint8Array(96);
    const started = performance.now();
    for (let index = 0; index < 100000; index++) Sha384.hash(input);
    console.log(`(100,000 hashes of 96 bytes in ${Math.round(performance.now() - started)} ms)`);
    process.exitCode = failures ? 1 : 0;
  }
}

new Sha384Test().run();
