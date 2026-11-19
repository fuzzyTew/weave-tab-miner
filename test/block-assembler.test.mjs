// test/block-assembler.test.mjs — whole blocks: starting from the first saved parent's state
// only, assemble each saved localnet block in turn from its mining solution (advancing the
// state with our own blocks, not the saved ones), and require every field to match the
// node's block. With the node's signature added, our block's id must be the node's.
// Fixtures as in test/account-tree.test.mjs.
// Run: node test/block-assembler.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AccountTree } from '../src/account-tree.js';
import { RewardHistory } from '../src/rewards.js';
import { BlockTimeHistory } from '../src/block-history.js';
import { BlockAssembler, ChainState } from '../src/block-assembler.js';
import { BlockHash } from '../src/block-hash.js';
import { Bytes } from '../src/miner.js';

class BlockAssemblerTest {
  // Set by the signer, not the assembler.
  static SIGNING_FIELDS = ['signature', 'indep_hash'];

  constructor(fixturesDirectory) {
    this.fixturesDirectory = fixturesDirectory;
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  async firstState(files) {
    const saved = JSON.parse(gunzipSync(readFileSync(`${this.fixturesDirectory}/${files.find((name) => name.startsWith('wallet_list_'))}`)));
    const accountTree = new AccountTree({ sha384: (bytes) => new Uint8Array(createHash('sha384').update(bytes).digest()) });
    for (const json of saved.wallets) {
      const { addressBytes, account } = AccountTree.accountFromJson(json);
      accountTree.insert(addressBytes, account);
    }
    const { parent } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${files.find((name) => name.startsWith('block_'))}`, 'utf8'));
    return new ChainState({
      block: parent.block,
      rewardHistory: RewardHistory.fromBinary(Bytes.fromBase64Url(parent.rewardHistory)),
      blockTimeHistory: BlockTimeHistory.fromBinary(Bytes.fromBase64Url(parent.blockTimeHistory)),
      accountTree,
    });
  }

  async run() {
    if (!existsSync(this.fixturesDirectory)) {
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    const files = readdirSync(this.fixturesDirectory).sort();
    const state = await this.firstState(files);
    for (const name of files.filter((file) => file.startsWith('block_'))) {
      const { child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const solution = Object.fromEntries(BlockAssembler.SOLUTION_FIELDS.filter((field) => field in child).map((field) => [field, child[field]]));
      const block = await BlockAssembler.assemble({ state, solution, rewardAddress: child.reward_addr, rewardKey: child.reward_key, timestamp: child.timestamp });
      const fieldNames = new Set([...Object.keys(child), ...Object.keys(block)].filter((field) => !BlockAssemblerTest.SIGNING_FIELDS.includes(field)));
      const differing = [...fieldNames].filter((field) => JSON.stringify(block[field]) !== JSON.stringify(child[field]));
      this.report(`block ${child.height}: all ${fieldNames.size} fields match the node's`, differing.length === 0, differing.length ? `differ: ${differing.join(', ')}` : '');
      const id = Bytes.toBase64Url(await BlockHash.indepHash({ ...block, signature: child.signature }));
      this.report(`block ${child.height}: with the node's signature, the same id`, id === child.indep_hash);
      BlockAssembler.advance(state, { ...block, signature: child.signature, indep_hash: id });
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

new BlockAssemblerTest(process.argv[2] ?? 'localnet_fixtures').run();
