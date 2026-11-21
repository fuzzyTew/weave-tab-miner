// test/transaction-picker.test.mjs — TransactionPicker's checks on made-up transactions: a valid
// one is picked and its effects seen by the next; a bad anchor, a repeat, an overspend, a
// fee under the least, and an id that is not its signature's hash are each refused with
// their reason; the account tree is left as it was. (The daily mainnet check runs it on
// real blocks' transactions, which it must all accept.)
// Run: node test/transaction-picker.test.mjs
import { createHash, randomBytes } from 'node:crypto';
import { Bytes } from '../src/core/bytes.js';
import { AccountTree } from '../src/blocks/account-tree.js';
import { ChainState } from '../src/blocks/assembler.js';
import { TransactionPicker } from '../src/blocks/transaction-picker.js';

class TransactionPickerTest {
  static sha256(bytes) {
    return new Uint8Array(createHash('sha256').update(bytes).digest());
  }

  /** A format-2 transaction from `owner`; its id is the hash of a made-up signature. */
  static transaction(owner, { lastTx, reward, quantity = 0n, target = '', dataSize = 0 }) {
    const signature = new Uint8Array(randomBytes(512));
    return {
      format: 2, id: Bytes.toBase64Url(TransactionPickerTest.sha256(signature)), owner: Bytes.toBase64Url(owner), signature: Bytes.toBase64Url(signature),
      last_tx: lastTx, target, quantity: String(quantity), reward: String(reward), data_size: String(dataSize),
      data_root: dataSize ? Bytes.toBase64Url(new Uint8Array(32).fill(1)) : '', tags: [],
    };
  }

  async run() {
    const owner = new Uint8Array(randomBytes(512));
    const sender = TransactionPickerTest.sha256(owner);
    const tree = new AccountTree();
    const senderLastTx = new Uint8Array(32).fill(7);
    tree.insert(sender, { balance: 10n ** 15n, lastTx: senderLastTx });
    const blockAnchor = Bytes.toBase64Url(new Uint8Array(48).fill(3));
    const parent = { denomination: 1, price_per_gib_minute: '9', kryder_plus_rate_multiplier: '1' };
    const state = new ChainState({ block: parent, accountTree: tree, recentBlocks: [{ indepHash: blockAnchor, txIds: ['recently-mined'] }] });
    const before = Bytes.toBase64Url(await tree.rootHash());

    const least = TransactionPicker.minimumFee({ data_size: 1000 }, { pricePerGibMinute: 9n, kryderMultiplier: 1n, targetExists: true });
    const good = TransactionPickerTest.transaction(owner, { lastTx: Bytes.toBase64Url(senderLastTx), reward: least, dataSize: 1000 });
    const anchoredToBlock = TransactionPickerTest.transaction(owner, { lastTx: blockAnchor, reward: least, dataSize: 1000 });
    const badAnchor = TransactionPickerTest.transaction(owner, { lastTx: Bytes.toBase64Url(new Uint8Array(32).fill(9)), reward: least, dataSize: 1000 });
    const tooCheap = TransactionPickerTest.transaction(owner, { lastTx: blockAnchor, reward: least - 1n, dataSize: 1000 });
    // To a new account, so its least fee includes the new-account fee.
    const newAccountLeast = TransactionPicker.minimumFee({ data_size: 0 }, { pricePerGibMinute: 9n, kryderMultiplier: 1n, targetExists: false });
    const overspend = TransactionPickerTest.transaction(owner, { lastTx: blockAnchor, reward: newAccountLeast, quantity: 10n ** 16n, target: Bytes.toBase64Url(new Uint8Array(32).fill(5)) });
    const forged = { ...TransactionPickerTest.transaction(owner, { lastTx: blockAnchor, reward: least, dataSize: 1000 }), id: Bytes.toBase64Url(new Uint8Array(32)) };
    const { picked, rejected } = await TransactionPicker.pick([good, anchoredToBlock, badAnchor, tooCheap, overspend, forged, good], state);

    const reasonFor = (json) => rejected.find((entry) => entry.id === json.id)?.reason ?? '';
    const checks = [
      ['a transaction anchored to the sender\'s last one, and one to a recent block, are picked', picked.length === 2 && picked[0] === good && picked[1] === anchoredToBlock],
      ['once one is picked, the sender\'s old last transaction no longer anchors another', /anchor/.test(reasonFor(badAnchor))],
      ['a fee one winston under the least is refused', /under the least/.test(reasonFor(tooCheap))],
      ['spending more than the balance is refused', /cannot pay/.test(reasonFor(overspend))],
      ['an id that is not the hash of the signature is refused', /hash of its signature/.test(reasonFor(forged))],
      ['the same transaction twice is refused', rejected.filter((entry) => entry.id === good.id).some((entry) => /already/.test(entry.reason))],
      ['the account tree is left as it was', Bytes.toBase64Url(await tree.rootHash()) === before],
    ];
    let failures = 0;
    for (const [name, passed] of checks) {
      if (!passed) failures++;
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
    }
    if (failures) console.log(JSON.stringify(rejected));
    process.exitCode = failures ? 1 : 0;
  }
}

await new TransactionPickerTest().run();
