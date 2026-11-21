// src/blocks/account-tree-snapshot.js — an AccountTree saved as bytes with its node hashes, so
// it comes back without re-reading 300,000 accounts from a node or rehashing them (about 20 s
// with the library SHA-384). Pages keep one between visits; tests keep one beside fixtures.
import { AccountTree } from './account-tree.js';

/**
 * The format, after an 8-byte magic: a LEB128 account count, then the root node and every
 * node below it in preorder (each node before its children). A node is
 *   suffix length and bytes (empty for the root),
 *   a flags byte (HAS_HASH, HAS_ACCOUNT, LONG_FORM, MINING_ALLOWED),
 *   the 48-byte hash if HAS_HASH,
 *   the account if HAS_ACCOUNT: balance bytes, last transaction bytes (each length first),
 *     and for the long form the denomination as LEB128,
 *   a LEB128 child count, then per child the bytes its key adds (as a byte string) and its node.
 * A child's key is its parent's key and suffix plus one distinguishing byte (a root child's
 * key is just the byte), which is how AccountTree.insert names nodes, so whole keys need not
 * be stored. The added bytes are stored with their length because an account with an empty
 * address (the localnet has one) sits at the root's child with the empty key.
 * LEB128 ("little-endian base 128") writes a number 7 bits per byte, low bits first, with
 * the top bit marking that more bytes follow.
 */
export class AccountTreeSnapshot {
  static MAGIC = 'WTMTREE1';
  static HASH_LENGTH = 48;
  static HAS_HASH = 1;
  static HAS_ACCOUNT = 2;
  static LONG_FORM = 4;
  static MINING_ALLOWED = 8;

  /** The tree's bytes. Hashes not yet worked out are left out and redone after loading. */
  static encode(tree) {
    const writer = new SnapshotWriter();
    writer.text(AccountTreeSnapshot.MAGIC);
    writer.number(tree.size);
    AccountTreeSnapshot.writeNode(writer, tree, AccountTree.ROOT);
    return writer.finished();
  }

  static writeNode(writer, tree, key) {
    const node = tree.nodes.get(key);
    writer.text(node.suffix ?? '');
    const account = node.value;
    let flags = 0;
    if (node.hash) flags |= AccountTreeSnapshot.HAS_HASH;
    if (account !== undefined) {
      flags |= AccountTreeSnapshot.HAS_ACCOUNT;
      if (account.denomination !== undefined) flags |= AccountTreeSnapshot.LONG_FORM;
      if (account.miningPermission) flags |= AccountTreeSnapshot.MINING_ALLOWED;
    }
    writer.byte(flags);
    if (node.hash) writer.bytes(node.hash);
    if (account !== undefined) {
      writer.sizedBytes(AccountTree.unsignedBytes(account.balance));
      writer.sizedBytes(account.lastTx);
      if (account.denomination !== undefined) writer.number(account.denomination);
    }
    writer.number(node.children.length);
    const childPrefixLength = key === AccountTree.ROOT ? 0 : key.length + node.suffix.length;
    for (const child of node.children) {
      writer.text(child.slice(childPrefixLength));
      AccountTreeSnapshot.writeNode(writer, tree, child);
    }
  }

  /**
   * An AccountTree from `encode`'s bytes; `treeOptions` go to its constructor. Hashes and
   * last transactions are views into `bytes`, so `bytes` must not be changed afterwards.
   */
  static decode(bytes, treeOptions = {}) {
    const reader = new SnapshotReader(bytes);
    const magic = reader.text(AccountTreeSnapshot.MAGIC.length);
    if (magic !== AccountTreeSnapshot.MAGIC) throw new Error(`not an account tree snapshot (it begins "${magic}")`);
    const tree = new AccountTree(treeOptions);
    tree.size = reader.number();
    tree.nodes.clear();
    AccountTreeSnapshot.readNode(reader, tree, AccountTree.ROOT, null);
    if (reader.offset !== bytes.length) throw new Error(`account tree snapshot has ${bytes.length - reader.offset} bytes after its last node`);
    return tree;
  }

  static readNode(reader, tree, key, parent) {
    const suffix = reader.text(reader.number());
    const flags = reader.byte();
    const hash = flags & AccountTreeSnapshot.HAS_HASH ? reader.bytes(AccountTreeSnapshot.HASH_LENGTH) : null;
    let value;
    if (flags & AccountTreeSnapshot.HAS_ACCOUNT) {
      value = { balance: reader.unsigned(reader.number()), lastTx: reader.bytes(reader.number()) };
      if (flags & AccountTreeSnapshot.LONG_FORM) {
        value.denomination = reader.number();
        value.miningPermission = Boolean(flags & AccountTreeSnapshot.MINING_ALLOWED);
      }
    }
    const node = { parent, children: [], hash, suffix: key === AccountTree.ROOT ? null : suffix, value };
    tree.nodes.set(key, node);
    const childPrefix = key === AccountTree.ROOT ? '' : key + suffix;
    const childCount = reader.number();
    for (let index = 0; index < childCount; index++) {
      const childKey = childPrefix + reader.text(reader.number());
      node.children.push(childKey); // written in order, so already sorted
      AccountTreeSnapshot.readNode(reader, tree, childKey, key);
    }
  }
}

/** Appends bytes to a buffer that doubles as it fills. */
class SnapshotWriter {
  constructor() {
    this.buffer = new Uint8Array(1 << 16);
    this.offset = 0;
  }

  room(count) {
    if (this.offset + count <= this.buffer.length) return;
    let length = this.buffer.length * 2;
    while (length < this.offset + count) length *= 2;
    const grown = new Uint8Array(length);
    grown.set(this.buffer.subarray(0, this.offset));
    this.buffer = grown;
  }

  byte(value) {
    this.room(1);
    this.buffer[this.offset++] = value;
  }

  number(value) {
    this.room(5);
    while (value >= 0x80) {
      this.buffer[this.offset++] = (value & 0x7f) | 0x80;
      value >>>= 7;
    }
    this.buffer[this.offset++] = value;
  }

  bytes(bytes) {
    this.room(bytes.length);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  sizedBytes(bytes) {
    this.number(bytes.length);
    this.bytes(bytes);
  }

  /** A byte string (one character per byte), its length first — except the fixed magic. */
  text(byteString) {
    if (byteString !== AccountTreeSnapshot.MAGIC) this.number(byteString.length);
    this.room(byteString.length);
    for (let index = 0; index < byteString.length; index++) this.buffer[this.offset++] = byteString.charCodeAt(index);
  }

  finished() {
    return this.buffer.slice(0, this.offset);
  }
}

/** Reads what SnapshotWriter wrote; throws on reading past the end. */
class SnapshotReader {
  constructor(bytes) {
    this.input = bytes;
    this.offset = 0;
  }

  need(count) {
    if (this.offset + count > this.input.length) throw new Error(`account tree snapshot ends early, at byte ${this.offset}`);
  }

  byte() {
    this.need(1);
    return this.input[this.offset++];
  }

  number() {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  }

  bytes(count) {
    this.need(count);
    const view = this.input.subarray(this.offset, this.offset + count);
    this.offset += count;
    return view;
  }

  /** Big-endian unsigned bytes as a BigInt. */
  unsigned(count) {
    const bytes = this.bytes(count);
    if (count <= 6) {
      let value = 0;
      for (const byte of bytes) value = value * 256 + byte;
      return BigInt(value);
    }
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return BigInt(`0x${hex}`);
  }

  text(count) {
    this.need(count);
    let text = '';
    for (let index = 0; index < count; index++) text += String.fromCharCode(this.input[this.offset + index]);
    this.offset += count;
    return text;
  }
}
