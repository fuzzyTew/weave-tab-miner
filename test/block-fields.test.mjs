// test/block-fields.test.mjs — every plain field of each saved localnet block, computed from
// its parent (the miner's timestamp taken from the real block). Fixtures as in
// test/account-tree.test.mjs.
// Run: node test/block-fields.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { NextBlockFields } from '../src/blocks/fields.js';
import { Bytes } from '../src/core/bytes.js';

class BlockFieldsTest {
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
      const { parent, child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const fields = NextBlockFields.compute({
        parent: parent.block, parentBlockTimeHistory: BlockTimeHistory.fromBinary(Bytes.fromBase64Url(parent.blockTimeHistory)), timestamp: child.timestamp,
      });
      const differing = Object.entries(fields).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(child[field]));
      if (differing.length) this.failures++;
      console.log(`${differing.length ? 'FAIL' : 'PASS'}  block ${child.height}: ${Object.keys(fields).length} fields from its parent${differing.length ? ' — differ: ' + differing.map(([field, value]) => `${field} ${JSON.stringify(value)} vs ${JSON.stringify(child[field])}`).join('; ') : ` (reward ${fields.reward})`}`);
    }
    this.checkEndowmentBranch();
    process.exitCode = this.failures ? 1 : 0;
  }

  /** The top-up from the endowment pool, which the fixtures never need: worked by hand. */
  checkEndowmentBranch() {
    const base = { height: 2_069_867, weaveSize: 10n ** 18n, pricePerGibMinute: 1000n, blockInterval: 120n, debtSupply: 0n, kryderLatch: 0n, kryderMultiplier: 1n };
    const expected = 20n * 10n ** 18n * 1000n * 120n / (60n * (1n << 30n));
    const inflation = NextBlockFields.reward({ ...base, weaveSize: 0n, endowmentPool: 0n }).reward;
    const topped = NextBlockFields.reward({ ...base, endowmentPool: 10n ** 20n });
    const short = NextBlockFields.reward({ ...base, endowmentPool: 5n });
    const passed = topped.reward === expected && topped.endowmentPool === 10n ** 20n - (expected - inflation)
      && short.endowmentPool === 0n && short.debtSupply === expected - inflation - 5n && short.kryderMultiplier === 2n && short.kryderLatch === 1n;
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  the endowment tops up a short reward, and its shortfall becomes debt and doubles Kryder+`);
  }
}

new BlockFieldsTest(process.argv[2] ?? 'localnet_fixtures').run();
