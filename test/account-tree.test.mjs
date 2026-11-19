// test/account-tree.test.mjs — AccountTree against blocks a real Arweave node made: the
// localnet's saved accounts must hash to the parent block's wallet_list root, and releasing
// each block's oldest locked reward must give each child block's root. The fixtures come
// from the "Localnet fixtures" workflow, on the localnet-fixtures branch:
//   git fetch origin localnet-fixtures && git archive FETCH_HEAD | tar x
// Run: node test/account-tree.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AccountTree } from '../src/blocks/account-tree.js';
import { RewardHistory } from '../src/blocks/rewards.js';
import { Bytes } from '../src/core/bytes.js';

class AccountTreeTest {
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
      // Not a failure: the fixtures are a separate 35 MB download (see the header).
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    const files = readdirSync(this.fixturesDirectory);
    const accountsFile = files.find((name) => name.startsWith('wallet_list_'));
    const saved = JSON.parse(gunzipSync(readFileSync(`${this.fixturesDirectory}/${accountsFile}`)));
    // Node's own SHA-384 is synchronous, which makes the first full hash several times faster.
    const tree = new AccountTree({ sha384: (bytes) => new Uint8Array(createHash('sha384').update(bytes).digest()) });
    for (const json of saved.wallets) {
      const { addressBytes, account } = AccountTree.accountFromJson(json);
      tree.insert(addressBytes, account);
    }
    const started = Date.now();
    const parentRoot = Bytes.toBase64Url(await tree.rootHash());
    this.report(`${saved.wallets.length} accounts hash to block ${saved.height}'s root`, parentRoot === saved.root, `${parentRoot.slice(0, 12)}… in ${((Date.now() - started) / 1000).toFixed(1)} s`);

    const blockFiles = files.filter((name) => name.startsWith('block_')).sort();
    for (const name of blockFiles) {
      const { parent, child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const released = RewardHistory.fromBinary(Bytes.fromBase64Url(parent.rewardHistory)).releasedReward();
      tree.applyReward(released.addressBytes, released.reward, Number(parent.block.denomination));
      const root = Bytes.toBase64Url(await tree.rootHash());
      this.report(`block ${child.height}: releasing ${released.reward} winston gives its root`, root === child.wallet_list, root.slice(0, 12) + '…');
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

new AccountTreeTest(process.argv[2] ?? 'localnet_fixtures').run();
