// src/transaction.js — build, sign and serialize Arweave format-2 data transactions,
// so a tab can store data on the network directly, paying the fee in AR from its own key.
import { Bytes, Sha256 } from './miner.js';

export class DataMerkle {
  /**
   * The data_root of a transaction: data is cut into chunks of at most 256 KiB, each
   * leaf commits to its chunk's hash and end offset, and branches commit to their two
   * children and the split point (arweave-js src/common/lib/merkle.ts). If the last
   * piece would be under 32 KiB, the last two chunks are split evenly instead.
   */
  static MAX_CHUNK_SIZE = 262144;
  static MIN_CHUNK_SIZE = 32768;

  static chunkRanges(byteLength) {
    const ranges = [];
    let cursor = 0;
    let rest = byteLength;
    while (rest >= DataMerkle.MAX_CHUNK_SIZE) {
      let chunkSize = DataMerkle.MAX_CHUNK_SIZE;
      const nextChunkSize = rest - DataMerkle.MAX_CHUNK_SIZE;
      if (nextChunkSize > 0 && nextChunkSize < DataMerkle.MIN_CHUNK_SIZE) chunkSize = Math.ceil(rest / 2);
      ranges.push([cursor, cursor + chunkSize]);
      cursor += chunkSize;
      rest -= chunkSize;
    }
    ranges.push([cursor, cursor + rest]);
    return ranges;
  }

  static offsetBytes(offset) {
    return Bytes.fromBigInt(BigInt(offset), 32);
  }

  static root(data) {
    let layer = DataMerkle.chunkRanges(data.length).map(([start, end]) => ({
      id: Sha256.hash(Sha256.hash(Sha256.hash(data.subarray(start, end))), Sha256.hash(DataMerkle.offsetBytes(end))),
      maxByteRange: end,
    }));
    while (layer.length > 1) {
      const nextLayer = [];
      for (let index = 0; index < layer.length; index += 2) {
        const [left, right] = [layer[index], layer[index + 1]];
        nextLayer.push(right
          ? { id: Sha256.hash(Sha256.hash(left.id), Sha256.hash(right.id), Sha256.hash(DataMerkle.offsetBytes(left.maxByteRange))), maxByteRange: right.maxByteRange }
          : left);
      }
      layer = nextLayer;
    }
    return layer[0].id;
  }
}

export class DeepHash {
  /**
   * Arweave's structured hash over nested lists of byte strings, using SHA-384
   * (arweave-js src/common/lib/deepHash.ts). It is what a transaction signature covers.
   */
  static async sha384(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-384', bytes));
  }

  static async of(item) {
    const encoder = new TextEncoder();
    if (Array.isArray(item)) {
      let accumulator = await DeepHash.sha384(encoder.encode(`list${item.length}`));
      for (const child of item) accumulator = await DeepHash.sha384(Bytes.concat(accumulator, await DeepHash.of(child)));
      return accumulator;
    }
    const tagHash = await DeepHash.sha384(encoder.encode(`blob${item.length}`));
    return DeepHash.sha384(Bytes.concat(tagHash, await DeepHash.sha384(item)));
  }
}

export class DataTransaction {
  /**
   * A format-2 transaction carrying data, signed by an ArweaveWallet. Small data
   * (one chunk, up to 256 KiB) travels inside the transaction itself; larger data would
   * need the separate chunk-upload route, which this class does not do.
   */
  static MAX_INLINE_DATA_SIZE = DataMerkle.MAX_CHUNK_SIZE;

  constructor({ data, tags = [], anchor, rewardWinston, target = '', quantityWinston = 0n }) {
    if (data.length > DataTransaction.MAX_INLINE_DATA_SIZE) throw new Error(`data is ${data.length} bytes; this class sends at most ${DataTransaction.MAX_INLINE_DATA_SIZE}`);
    const encoder = new TextEncoder();
    this.data = data;
    this.tags = tags.map(([name, value]) => [encoder.encode(name), encoder.encode(value)]);
    this.anchor = anchor;
    this.rewardWinston = BigInt(rewardWinston);
    this.target = target;
    this.quantityWinston = BigInt(quantityWinston);
    this.dataRoot = data.length > 0 ? DataMerkle.root(data) : new Uint8Array(0);
    this.signature = null;
    this.owner = null;
  }

  async signatureData(ownerBytes) {
    const encoder = new TextEncoder();
    return DeepHash.of([
      encoder.encode('2'), ownerBytes, Bytes.fromBase64Url(this.target),
      encoder.encode(this.quantityWinston.toString()), encoder.encode(this.rewardWinston.toString()),
      Bytes.fromBase64Url(this.anchor), this.tags,
      encoder.encode(String(this.data.length)), this.dataRoot,
    ]);
  }

  async sign(wallet) {
    this.owner = wallet.owner;
    this.signature = await wallet.sign(await this.signatureData(wallet.ownerBytes));
    this.id = Bytes.toBase64Url(Sha256.hash(this.signature));
    return this;
  }

  /** The JSON the node's POST /tx accepts. */
  toJson() {
    if (!this.signature) throw new Error('sign the transaction before serializing it');
    return {
      format: 2, id: this.id, last_tx: this.anchor, owner: this.owner,
      tags: this.tags.map(([name, value]) => ({ name: Bytes.toBase64Url(name), value: Bytes.toBase64Url(value) })),
      target: this.target, quantity: this.quantityWinston.toString(), data: Bytes.toBase64Url(this.data),
      data_size: String(this.data.length), data_root: Bytes.toBase64Url(this.dataRoot),
      reward: this.rewardWinston.toString(), signature: Bytes.toBase64Url(this.signature),
    };
  }
}
