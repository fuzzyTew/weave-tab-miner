// test/account-tree.test.mjs — AccountTree against blocks a real Arweave node made: the
// localnet's saved accounts must hash to the parent block's wallet_list root, and releasing
// each block's oldest locked reward must give each child block's root. The fixtures come
// from the "Localnet fixtures" workflow, on the localnet-fixtures branch:
//   git fetch origin localnet-fixtures && git archive FETCH_HEAD | tar x
// Run: node test/account-tree.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { AccountTree } from '../src/blocks/account-tree.js';
import { RewardHistory } from '../src/blocks/rewards.js';
import { Bytes } from '../src/core/bytes.js';
import { FixtureAccountTree } from './fixture-account-tree.mjs';
import { TestCase } from './test-case.mjs';

class AccountTreeTest extends TestCase {
  constructor(fixturesDirectory) {
    super();
    this.fixturesDirectory = fixturesDirectory;
  }


  async run() {
    if (!existsSync(this.fixturesDirectory)) {
      // Not a failure: the fixtures are a separate 35 MB download (see the header).
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    const files = readdirSync(this.fixturesDirectory);
    const accountsFile = files.find((name) => name.startsWith('wallet_list_'));
    const walletFile = `${this.fixturesDirectory}/${accountsFile}`;
    const blockFiles = files.filter((name) => name.startsWith('block_')).sort();
    const { block: firstParent } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${blockFiles[0]}`, 'utf8')).parent;
    const loaded = await FixtureAccountTree.load(walletFile, firstParent.wallet_list);
    const tree = loaded.tree;
    this.report(`the accounts hash to block ${firstParent.height}'s root`, loaded.root === firstParent.wallet_list, FixtureAccountTree.describe(loaded));

    for (const name of blockFiles) {
      const { parent, child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const released = RewardHistory.fromBinary(Bytes.fromBase64Url(parent.rewardHistory)).releasedReward();
      tree.applyReward(released.addressBytes, released.reward, Number(parent.block.denomination));
      const root = Bytes.toBase64Url(await tree.rootHash());
      this.report(`block ${child.height}: releasing ${released.reward} winston gives its root`, root === child.wallet_list, root.slice(0, 12) + '…');
    }
    this.finish();
  }
}

new AccountTreeTest(process.argv[2] ?? 'localnet_fixtures').run();
