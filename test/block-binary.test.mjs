// test/block-binary.test.mjs — each saved localnet block encoded to the binary form nodes
// accept (POST /block2) must equal, byte for byte, the binary the node itself served
// (GET /block2/height). Fixtures as in test/account-tree.test.mjs.
// Run: node test/block-binary.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { BlockBinary } from '../src/block-binary.js';

class BlockBinaryTest {
  constructor(fixturesDirectory) {
    this.fixturesDirectory = fixturesDirectory;
    this.failures = 0;
  }

  run() {
    if (!existsSync(this.fixturesDirectory)) {
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    for (const name of readdirSync(this.fixturesDirectory).filter((file) => file.startsWith('block_')).sort()) {
      const { child, childBinary } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const ours = BlockBinary.encode(child);
      // The capture saved the node's bytes as standard base64.
      const theirs = new Uint8Array(Buffer.from(childBinary, 'base64'));
      let firstDifference = -1;
      for (let index = 0; index < Math.max(ours.length, theirs.length); index++) {
        if (ours[index] !== theirs[index]) { firstDifference = index; break; }
      }
      if (firstDifference >= 0) this.failures++;
      console.log(`${firstDifference < 0 ? 'PASS' : 'FAIL'}  block ${child.height}: ${ours.length} bytes${firstDifference < 0 ? ', identical to the node\'s' : `, first difference at byte ${firstDifference} of ${theirs.length}`}`);
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

new BlockBinaryTest(process.argv[2] ?? 'localnet_fixtures').run();
