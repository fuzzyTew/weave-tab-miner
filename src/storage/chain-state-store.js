// src/storage/chain-state-store.js — keeps the followed chain state in the browser between
// visits, so a returning page catches up a few blocks instead of reading 300,000 accounts
// (tens of MB) from a node and hashing them again (about 20 s, longer on a phone).
import { ChainState } from '../blocks/assembler.js';
import { AccountTreeSnapshot } from '../blocks/account-tree-snapshot.js';
import { BlockTimeHistory } from '../blocks/history.js';
import { NetworkRules } from '../blocks/network-rules.js';
import { RewardHistory } from '../blocks/rewards.js';
import { BrowserObjectStore } from './browser-object-store.js';

export class ChainStateStore extends BrowserObjectStore {
  /**
   * One saved ChainState, the latest, under SAVED_KEY. IndexedDB keeps BigInts and byte
   * arrays as they are, so the histories are stored as their entries; the account tree as
   * an AccountTreeSnapshot, with its hashes. Only the mainnet's state is kept.
   */
  static DATABASE_NAME = 'weave-tab-miner-chain-state';
  static STORE_NAME = 'chain-state';
  static SAVED_KEY = 'latest';
  static FORMAT = 1;

  constructor({ log = () => {} } = {}) {
    super({ databaseName: ChainStateStore.DATABASE_NAME, storeName: ChainStateStore.STORE_NAME, log });
  }

  /** Saves `state` (its tree fully hashed, as after following a block); resolves whether saved. */
  async save(state) {
    return this.put(ChainStateStore.SAVED_KEY, {
      format: ChainStateStore.FORMAT,
      block: state.block,
      rewardHistory: state.rewardHistory.entries,
      blockTimeHistory: state.blockTimeHistory.entries,
      recentBlocks: state.recentBlocks,
      accountTree: AccountTreeSnapshot.encode(state.accountTree),
    });
  }

  /** The saved ChainState, or null if there is none (or it is from another format). */
  async load() {
    const saved = await this.get(ChainStateStore.SAVED_KEY);
    if (!saved || saved.format !== ChainStateStore.FORMAT) return null;
    return new ChainState({
      block: saved.block,
      rewardHistory: new RewardHistory(saved.rewardHistory),
      blockTimeHistory: new BlockTimeHistory(saved.blockTimeHistory),
      recentBlocks: saved.recentBlocks,
      accountTree: AccountTreeSnapshot.decode(saved.accountTree),
      rules: NetworkRules.MAINNET,
    });
  }
}
