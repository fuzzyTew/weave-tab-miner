// test/account-changes.test.mjs — AccountTree's account changes without fixtures: transactions as
// ar_node_utils:apply_tx makes them (sender pays quantity and fee, target receives, a
// missing sender changes nothing), and withUndoneChanges putting every touched account
// back, including removing one it created, so the root returns to what it was; and a tree
// saved and loaded as an AccountTreeSnapshot.
// Run: node test/account-changes.test.mjs
import { createHash, randomBytes } from 'node:crypto';
import { AccountTree } from '../src/blocks/account-tree.js';
import { AccountTreeSnapshot } from '../src/blocks/account-tree-snapshot.js';

class AccountChangesTest {
  constructor() {
    this.failures = 0;
    this.tree = new AccountTree({ sha384: (bytes) => new Uint8Array(createHash('sha384').update(bytes).digest()) });
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  static address(firstByte) {
    const bytes = new Uint8Array(randomBytes(32));
    bytes[0] = firstByte;
    return bytes;
  }

  /**
   * A snapshot brings back the tree with its hashes: the same bytes when encoded again, and
   * the same root after a change. It includes an empty address (the localnet has one), a
   * long-form account, a banned one and a balance past 2^64.
   */
  async checkSnapshot(tree, rootBefore) {
    tree.insert(new Uint8Array(0), { balance: 5n, lastTx: new Uint8Array(0) });
    tree.insert(AccountChangesTest.address(6), { balance: 2n ** 70n, lastTx: new Uint8Array(32).fill(1), denomination: 2, miningPermission: false });
    await tree.rootHash();
    const bytes = AccountTreeSnapshot.encode(tree);
    const copy = AccountTreeSnapshot.decode(bytes, { sha384: tree.sha384 });
    const sameBytes = Buffer.from(AccountTreeSnapshot.encode(copy)).equals(Buffer.from(bytes));
    const changed = AccountChangesTest.address(7);
    for (const changing of [tree, copy]) changing.credit(changed, 3n, 1);
    const sameRoot = Buffer.from(await copy.rootHash()).equals(Buffer.from(await tree.rootHash()));
    this.report('a snapshot round-trips, and its tree hashes changes as the original does', sameBytes && sameRoot && copy.size === tree.size);
  }

  async run() {
    const tree = this.tree;
    for (let index = 0; index < 2000; index++) tree.insert(new Uint8Array(randomBytes(32)), { balance: BigInt(index), lastTx: new Uint8Array(0) });
    const sender = AccountChangesTest.address(1);
    const target = AccountChangesTest.address(2);
    tree.insert(sender, { balance: 1000n, lastTx: new Uint8Array(0) });
    const id = new Uint8Array(32).fill(9);

    tree.applyTransaction({ idBytes: id, ownerAddressBytes: sender, targetBytes: target, quantity: 300n, reward: 50n, denomination: 0 }, 1);
    this.report('the sender pays quantity and fee, and its last transaction is this one', tree.get(sender).balance === 650n && tree.get(sender).lastTx[0] === 9);
    this.report('a new target account receives the quantity, with no last transaction', tree.get(target).balance === 300n && tree.get(target).lastTx.length === 0);

    const stranger = AccountChangesTest.address(3);
    tree.applyTransaction({ idBytes: id, ownerAddressBytes: stranger, targetBytes: AccountChangesTest.address(4), quantity: 5n, reward: 1n, denomination: 0 }, 1);
    this.report('a sender with no account changes nothing', tree.get(stranger) === undefined && tree.size === 2002);

    const before = Buffer.from(await tree.rootHash()).toString('hex');
    const created = AccountChangesTest.address(5);
    const changedRoot = await tree.withUndoneChanges(async (changing) => {
      changing.credit(created, 7n, 1);
      changing.credit(sender, 1n, 1);
      return Buffer.from(await changing.rootHash()).toString('hex');
    });
    const after = Buffer.from(await tree.rootHash()).toString('hex');
    this.report('withUndoneChanges puts back a changed and a created account, and the root', changedRoot !== before && after === before && tree.get(created) === undefined && tree.get(sender).balance === 650n);
    await this.checkSnapshot(tree, before);
    process.exitCode = this.failures ? 1 : 0;
  }
}

await new AccountChangesTest().run();
