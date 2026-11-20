// src/blocks/account-tree.js — Arweave's account tree and its root hash (a block's `wallet_list`),
// ported from the node: ar_patricia_tree_core.erl (insert, compute_hash) with the account
// hashing of ar_block.erl wallet_list_hash_fun. Step 1 of docs/TODO.md "Turn a solution into a block".
//
// A Patricia tree (also called a radix tree) stores keys by their shared beginnings: each
// node holds the bytes its keys have in common, and branches where they differ.
import { Bytes } from '../core/bytes.js';
import { Denomination } from '../core/denomination.js';

export class AccountTree {
  /**
   * Accounts keyed by address bytes. Mirrors the node's tree node for node, so its root
   * matches whatever order accounts were inserted in.
   *
   * Keys are kept as "byte strings" (one character per byte, codes 0–255): JavaScript
   * compares those exactly as Erlang orders binaries (byte by byte, a prefix first), which
   * is the order the node hashes children in (gb_sets).
   *
   * `sha384(bytes)` may return a Uint8Array or a Promise of one; the default uses WebCrypto.
   * A synchronous one (Node's crypto) makes hashing the whole tree several times faster.
   */
  static ROOT = 'root';

  constructor({ sha384 = AccountTree.webCryptoSha384 } = {}) {
    this.sha384 = sha384;
    this.nodes = new Map([[AccountTree.ROOT, { parent: null, children: [], hash: null, suffix: null, value: undefined }]]);
    this.size = 0;
  }

  static async webCryptoSha384(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-384', bytes));
  }

  static toByteString(bytes) {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
  }

  static fromByteString(text) {
    return Uint8Array.from(text, (character) => character.charCodeAt(0));
  }

  static commonPrefixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) index++;
    return index;
  }

  /** Children are kept sorted, as the node's gb_sets are. */
  static addChild(children, key) {
    let low = 0;
    let high = children.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (children[middle] < key) low = middle + 1; else high = middle;
    }
    if (children[low] !== key) children.splice(low, 0, key);
  }

  invalidate(key) {
    for (let current = key; current !== null; current = this.nodes.get(current).parent) this.nodes.get(current).hash = null;
  }

  /**
   * Adds or replaces an account. `account` is { balance (BigInt), lastTx (Uint8Array) } for
   * old-style accounts, plus { denomination, miningPermission } for new-style ones.
   */
  insert(addressBytes, account) {
    const key = AccountTree.toByteString(addressBytes);
    let level = 1;
    let parent = AccountTree.ROOT;
    for (;;) {
      const keyPrefix = key.slice(0, level);
      const keySuffix = key.slice(level);
      const node = this.nodes.get(keyPrefix);
      if (!node) {
        this.nodes.set(keyPrefix, { parent, children: [], hash: null, suffix: keySuffix, value: account });
        AccountTree.addChild(this.nodes.get(parent).children, keyPrefix);
        this.size++;
        this.invalidate(parent);
        return;
      }
      const commonLength = AccountTree.commonPrefixLength(keySuffix, node.suffix);
      const common = keySuffix.slice(0, commonLength);
      if (keySuffix === node.suffix) {
        if (node.value === undefined) this.size++;
        node.value = account;
        node.hash = null;
        this.invalidate(node.parent);
        return;
      }
      if (common === node.suffix) {
        // The node's suffix begins the key's: go below it.
        level += node.suffix.length + 1;
        parent = keyPrefix;
        continue;
      }
      // Split the node where the key and its suffix part ways.
      const nodeHeadKey = keyPrefix + common + node.suffix[commonLength];
      const movedNode = { parent: keyPrefix, children: node.children, hash: node.hash, suffix: node.suffix.slice(commonLength + 1), value: node.value };
      this.nodes.set(nodeHeadKey, movedNode);
      for (const child of movedNode.children) this.nodes.get(child).parent = nodeHeadKey;
      if (common === keySuffix) {
        // The key ends inside the node's suffix: the key's account sits at the split.
        this.nodes.set(keyPrefix, { parent: node.parent, children: [nodeHeadKey], hash: null, suffix: keySuffix, value: account });
      } else {
        const newKey = keyPrefix + common + keySuffix[commonLength];
        this.nodes.set(newKey, { parent: keyPrefix, children: [], hash: null, suffix: keySuffix.slice(commonLength + 1), value: account });
        const children = [];
        AccountTree.addChild(children, newKey);
        AccountTree.addChild(children, nodeHeadKey);
        this.nodes.set(keyPrefix, { parent: node.parent, children, hash: null, suffix: common, value: undefined });
      }
      this.size++;
      this.invalidate(node.parent);
      return;
    }
  }

  /**
   * Removes an address's account, to undo an insert. Only a leaf's node is deleted; nodes
   * left with no account and one child are kept, since such a node passes its child's hash
   * up unchanged, so the root is what a tree built without the account would have.
   */
  remove(addressBytes) {
    const key = AccountTree.toByteString(addressBytes);
    let level = 1;
    for (;;) {
      const nodeKey = key.slice(0, level);
      const node = this.nodes.get(nodeKey);
      if (!node) return;
      const keySuffix = key.slice(level);
      if (keySuffix === node.suffix) {
        if (node.value === undefined) return;
        this.size--;
        if (node.children.length) {
          node.value = undefined;
          node.hash = null;
          this.invalidate(node.parent);
          return;
        }
        this.nodes.delete(nodeKey);
        const siblings = this.nodes.get(node.parent).children;
        siblings.splice(siblings.indexOf(nodeKey), 1);
        this.invalidate(node.parent);
        return;
      }
      if (!keySuffix.startsWith(node.suffix)) return;
      level += node.suffix.length + 1;
    }
  }

  /**
   * Runs `change(tree)` and then puts back every account it touched through `putAccount`
   * (insert or remove), so a root can be worked out for a block that may never be
   * accepted. Resolves whatever `change` resolves.
   */
  async withUndoneChanges(change) {
    const saved = new Map();
    const originalPut = this.putAccount;
    this.putAccount = (addressBytes, account) => {
      const key = AccountTree.toByteString(addressBytes);
      if (!saved.has(key)) saved.set(key, this.get(addressBytes));
      originalPut.call(this, addressBytes, account);
    };
    try {
      return await change(this);
    } finally {
      this.putAccount = originalPut;
      for (const [key, account] of saved) {
        const addressBytes = AccountTree.fromByteString(key);
        if (account === undefined) this.remove(addressBytes);
        else this.insert(addressBytes, account);
      }
    }
  }

  /** The account stored under an address, or undefined (the node's lookup/4). */
  get(addressBytes) {
    const key = AccountTree.toByteString(addressBytes);
    let level = 1;
    for (;;) {
      const node = this.nodes.get(key.slice(0, level));
      if (!node) return undefined;
      const keySuffix = key.slice(level);
      if (keySuffix === node.suffix) return node.value;
      if (!keySuffix.startsWith(node.suffix)) return undefined;
      level += node.suffix.length + 1;
    }
  }

  /**
   * Stores an account in the form update_account (ar_node_utils.erl) gives it: the short
   * form for denomination 1 with mining allowed, the long form otherwise.
   */
  putAccount(addressBytes, { balance, lastTx, denomination, miningPermission = true }) {
    this.insert(addressBytes, denomination === 1 && miningPermission
      ? { balance, lastTx }
      : { balance, lastTx, denomination, miningPermission });
  }

  /** An account's balance in `denomination`; short-form accounts are in denomination 1. */
  static balanceIn(account, denomination) {
    return Denomination.redenominate(account.balance, account.denomination ?? 1, denomination);
  }

  /**
   * Adds `amount` (already in the block's `denomination`) to an address, as
   * ar_rewards:apply_reward and update_recipient_balance do: a new address gets an
   * account with no last transaction. `skipBanned` leaves banned accounts (mining
   * permission false) unpaid, as reward releases do; transfers still reach them.
   */
  credit(addressBytes, amount, denomination, { skipBanned = false } = {}) {
    const existing = this.get(addressBytes);
    const miningPermission = existing?.miningPermission ?? true;
    if (skipBanned && !miningPermission) return;
    this.putAccount(addressBytes, {
      balance: (existing ? AccountTree.balanceIn(existing, denomination) : 0n) + BigInt(amount),
      lastTx: existing?.lastTx ?? new Uint8Array(0), denomination, miningPermission,
    });
  }

  /** A released mining reward (ar_rewards:apply_rewards2), in the block's denomination. */
  applyReward(addressBytes, amount, denomination) {
    this.credit(addressBytes, amount, denomination, { skipBanned: true });
  }

  /**
   * One transaction's account changes (ar_node_utils:apply_tx): the sender pays quantity
   * and fee and its last transaction becomes this one; the target receives the quantity.
   * A sender with no account changes nothing at all. `transaction` holds
   * { idBytes, ownerAddressBytes, targetBytes, quantity, reward, denomination } with
   * BigInt amounts in the transaction's own denomination.
   */
  applyTransaction(transaction, denomination) {
    const sender = this.get(transaction.ownerAddressBytes);
    if (!sender) return;
    const spent = Denomination.redenominate(transaction.quantity + transaction.reward, transaction.denomination, denomination);
    this.putAccount(transaction.ownerAddressBytes, {
      balance: AccountTree.balanceIn(sender, denomination) - spent, lastTx: transaction.idBytes,
      denomination, miningPermission: sender.miningPermission ?? true,
    });
    if (transaction.quantity === 0n) return;
    this.credit(transaction.targetBytes, Denomination.redenominate(transaction.quantity, transaction.denomination, denomination), denomination);
  }

  /** Arweave's deep hash (ar_deep_hash.erl) with this tree's SHA-384. */
  async deepHash(item) {
    const encoder = new TextEncoder();
    if (Array.isArray(item)) {
      let accumulator = await this.sha384(encoder.encode(`list${item.length}`));
      for (const child of item) accumulator = await this.sha384(Bytes.concat(accumulator, await this.deepHash(child)));
      return accumulator;
    }
    const tagHash = await this.sha384(encoder.encode(`blob${item.length}`));
    return this.sha384(Bytes.concat(tagHash, await this.sha384(item)));
  }

  /** binary:encode_unsigned: big-endian, no leading zeros, and one zero byte for 0. */
  static unsignedBytes(value) {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    return Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
  }

  /** ar_serialize:encode_bin(Bin, 8): a one-byte length, then the bytes. */
  static lengthPrefixed(bytes) {
    if (bytes.length > 255) throw new Error(`field of ${bytes.length} bytes does not fit an 8-bit length`);
    return Bytes.concat(new Uint8Array([bytes.length]), bytes);
  }

  /** wallet_list_hash_fun(leaf, ...): the two account layouts hash differently. */
  async leafHash(addressBytes, account) {
    if (account.denomination === undefined) {
      return this.deepHash([addressBytes, AccountTree.unsignedBytes(account.balance), account.lastTx]);
    }
    return this.sha384(Bytes.concat(
      AccountTree.lengthPrefixed(addressBytes),
      AccountTree.lengthPrefixed(AccountTree.unsignedBytes(account.balance)),
      AccountTree.lengthPrefixed(account.lastTx),
      AccountTree.lengthPrefixed(AccountTree.unsignedBytes(account.denomination)),
      new Uint8Array([account.miningPermission ? 1 : 0])));
  }

  /**
   * The root hash (do_compute_hash): a leaf hashes its account; a node hashes its own
   * account (if any) followed by its children's hashes in order; a node with no account
   * and one child passes that child's hash up unchanged. An empty tree's root is empty.
   * Hashes are cached on nodes, so after a few changes only their paths are rehashed.
   */
  async rootHash() {
    if (this.size === 0) return new Uint8Array(0);
    return this.nodeHash(AccountTree.ROOT);
  }

  async nodeHash(key) {
    const node = this.nodes.get(key);
    if (node.hash) return node.hash;
    const fullKey = () => AccountTree.fromByteString(key + node.suffix);
    if (node.children.length === 0) {
      node.hash = await this.leafHash(fullKey(), node.value);
      return node.hash;
    }
    const childHashes = [];
    for (const child of node.children) childHashes.push(await this.nodeHash(child));
    if (node.value !== undefined) {
      node.hash = await this.deepHash([await this.leafHash(fullKey(), node.value), ...childHashes]);
    } else {
      node.hash = childHashes.length === 1 ? childHashes[0] : await this.deepHash(childHashes);
    }
    return node.hash;
  }

  /** An account from GET /wallet_list's JSON ({ address, balance, last_tx, ... }). */
  static accountFromJson(json) {
    const account = { balance: BigInt(json.balance), lastTx: Bytes.fromBase64Url(json.last_tx) };
    if (json.denomination !== undefined) Object.assign(account, { denomination: json.denomination, miningPermission: Boolean(json.mining_permission) });
    return { addressBytes: Bytes.fromBase64Url(json.address), account };
  }
}
