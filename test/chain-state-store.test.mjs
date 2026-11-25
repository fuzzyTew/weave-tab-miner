// test/chain-state-store.test.mjs — ChainStateStore saving and loading a ChainState through
// structured cloning, which is what IndexedDB does to a stored value (Node has no IndexedDB,
// so a Map stands in for the object store). Run: node test/chain-state-store.test.mjs
import { createHash, randomBytes } from 'node:crypto';
import { AccountTree } from '../src/blocks/account-tree.js';
import { ChainState } from '../src/blocks/assembler.js';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { RewardHistory } from '../src/blocks/rewards.js';
import { ChainStateStore } from '../src/storage/chain-state-store.js';
import { NetworkTarget } from '../src/network/network-target.js';

/** A ChainStateStore whose object store is a Map, cloning values as IndexedDB would. */
class MapChainStateStore extends ChainStateStore {
  values = new Map();

  async get(key) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : undefined;
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
    return true;
  }
}

class ChainStateStoreTest {
  constructor() {
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  async run() {
    const store = new MapChainStateStore({ network: NetworkTarget.MAINNET });
    this.report('nothing saved loads as null', await store.load() === null);

    const sha384 = (bytes) => new Uint8Array(createHash('sha384').update(bytes).digest());
    const accountTree = new AccountTree({ sha384 });
    for (let index = 0; index < 500; index++) accountTree.insert(new Uint8Array(randomBytes(32)), { balance: BigInt(index) * 10n ** 15n, lastTx: new Uint8Array(randomBytes(32)) });
    const root = Buffer.from(await accountTree.rootHash()).toString('hex');
    const state = new ChainState({
      block: { height: '42', indep_hash: 'abc' },
      rewardHistory: new RewardHistory([{ addressBytes: new Uint8Array(32).fill(7), hashRate: 10n ** 20n, reward: 5n, denomination: 1 }]),
      blockTimeHistory: new BlockTimeHistory([{ blockInterval: 120n, vdfInterval: 125n, chunkCount: 2n }]),
      recentBlocks: [{ indepHash: 'abc', txIds: ['t1'] }],
      accountTree,
    });
    this.report('a state saves', await store.save(state));

    const loaded = await store.load();
    const loadedRoot = Buffer.from(await loaded.accountTree.rootHash()).toString('hex');
    this.report('it loads with the same block, histories, recent blocks and account root',
      loaded.block.height === '42' && loaded.rewardHistory.entries[0].hashRate === 10n ** 20n
      && loaded.rewardHistory.entries[0].addressBytes[0] === 7 && loaded.blockTimeHistory.entries[0].vdfInterval === 125n
      && loaded.recentBlocks[0].txIds[0] === 't1' && loadedRoot === root && loaded.accountTree.size === 500);

    const localnet = new MapChainStateStore({ network: NetworkTarget.localnet('http://127.0.0.1:1985') });
    localnet.values = store.values;
    this.report('a localnet keeps its own state, under its own rules', await localnet.load() === null && await localnet.save(state) && (await localnet.load()).rules.name === 'localnet');
    store.values.set(ChainStateStore.SAVED_KEY, { ...store.values.get(ChainStateStore.SAVED_KEY), format: ChainStateStore.FORMAT + 1 });
    this.report('a state saved in another format loads as null', await store.load() === null);
    process.exitCode = this.failures ? 1 : 0;
  }
}

await new ChainStateStoreTest().run();
