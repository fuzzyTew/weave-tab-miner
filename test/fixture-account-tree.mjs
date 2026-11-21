// test/fixture-account-tree.mjs — the account tree saved in a fixtures directory, built once.
// The first run inserts every account and hashes the whole tree (about 20 s for 300,000);
// when the root matches the block's, the tree is kept as an AccountTreeSnapshot beside the
// fixtures, so later runs and other tests load it in well under a second.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { AccountTree } from '../src/blocks/account-tree.js';
import { AccountTreeSnapshot } from '../src/blocks/account-tree-snapshot.js';
import { Bytes } from '../src/core/bytes.js';

export class FixtureAccountTree {
  /**
   * Resolves { tree, root, fromSnapshot, accountCount, seconds } for the wallet list in
   * `walletFile` (gzipped JSON with a `wallets` list), whose root should be `expectedRoot`
   * (base64url). The snapshot is only written when the freshly hashed root matches.
   */
  static async load(walletFile, expectedRoot) {
    const snapshotFile = `${walletFile}.${expectedRoot.slice(0, 16)}.snapshot`;
    const started = performance.now();
    if (existsSync(snapshotFile)) {
      const tree = AccountTreeSnapshot.decode(readFileSync(snapshotFile));
      return FixtureAccountTree.loaded(tree, true, started);
    }
    const { wallets } = JSON.parse(gunzipSync(readFileSync(walletFile)));
    const tree = new AccountTree();
    for (const json of wallets) {
      const { addressBytes, account } = AccountTree.accountFromJson(json);
      tree.insert(addressBytes, account);
    }
    const loaded = await FixtureAccountTree.loaded(tree, false, started);
    if (loaded.root === expectedRoot) writeFileSync(snapshotFile, AccountTreeSnapshot.encode(tree));
    return loaded;
  }

  static async loaded(tree, fromSnapshot, started) {
    const root = Bytes.toBase64Url(await tree.rootHash());
    return { tree, root, fromSnapshot, accountCount: tree.size, seconds: (performance.now() - started) / 1000 };
  }

  /** A line for test output: how many accounts, and whether they came from the snapshot. */
  static describe({ accountCount, fromSnapshot, seconds }) {
    return `${accountCount} accounts ${fromSnapshot ? 'from the saved snapshot' : 'inserted and hashed'} in ${seconds.toFixed(2)} s`;
  }
}
