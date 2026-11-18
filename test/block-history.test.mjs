// test/block-history.test.mjs — the reward history hash, block-time history hash and block
// index hash of each saved localnet block, computed from its parent alone. Fixtures as in
// test/account-tree.test.mjs.
// Run: node test/block-history.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { BlockHistoryHashes, BlockTimeHistory } from '../src/block-history.js';
import { Bytes } from '../src/miner.js';

class BlockHistoryTest {
  constructor(fixturesDirectory) {
    this.fixturesDirectory = fixturesDirectory;
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  async run() {
    if (!existsSync(this.fixturesDirectory)) {
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    for (const name of readdirSync(this.fixturesDirectory).filter((file) => file.startsWith('block_')).sort()) {
      const { parent, child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const rewardHash = BlockHistoryHashes.rewardHistoryHash(child, Bytes.fromBase64Url(parent.block.reward_history_hash));
      this.report(`block ${child.height}: reward_history_hash`, Bytes.toBase64Url(rewardHash) === child.reward_history_hash);
      const history = BlockTimeHistory.fromBinary(Bytes.fromBase64Url(parent.blockTimeHistory)).withNewest(BlockTimeHistory.elementFor(child, parent.block));
      this.report(`block ${child.height}: block_time_history_hash`, Bytes.toBase64Url(history.hash()) === child.block_time_history_hash, `over ${Math.min(history.entries.length, BlockTimeHistory.HISTORY_BLOCKS)} entries`);
      const merkle = await BlockHistoryHashes.hashListMerkle(parent.block);
      this.report(`block ${child.height}: hash_list_merkle`, Bytes.toBase64Url(merkle) === child.hash_list_merkle);
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

new BlockHistoryTest(process.argv[2] ?? 'localnet_fixtures').run();
