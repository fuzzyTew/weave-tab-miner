// src/bundle.js — ANS-104 data items: small signed records that a bundler (such as
// ArDrive's Turbo) packs into one Arweave transaction. Turbo stores items up to 100 KiB for
// free, so a key with no AR can still store a record. The item is signed here with the
// person's own key, so its id and authorship do not depend on the bundler; only getting it
// into a block does.
import { Bytes, Sha256 } from './miner.js';
import { DeepHash } from './transaction.js';

export class AvroTags {
  /**
   * The tag encoding ANS-104 uses: an Avro array of records { name: bytes, value: bytes }.
   * Avro writes each count and length as a "zigzag varint" (a signed integer folded onto
   * the unsigned ones — 0, -1, 1, -2… become 0, 1, 2, 3… — then written 7 bits a byte),
   * and ends the array with a zero count. No tags encode as no bytes at all.
   */
  static zigzagVarint(value) {
    let folded = BigInt(value) >= 0n ? BigInt(value) * 2n : -BigInt(value) * 2n - 1n;
    const bytes = [];
    do {
      let byte = Number(folded & 0x7fn);
      folded >>= 7n;
      if (folded > 0n) byte |= 0x80;
      bytes.push(byte);
    } while (folded > 0n);
    return new Uint8Array(bytes);
  }

  /** `tags` is a list of [name, value] byte arrays. */
  static encode(tags) {
    if (!tags.length) return new Uint8Array(0);
    const parts = [AvroTags.zigzagVarint(tags.length)];
    for (const [name, value] of tags) parts.push(AvroTags.zigzagVarint(name.length), name, AvroTags.zigzagVarint(value.length), value);
    parts.push(new Uint8Array([0]));
    return Bytes.concat(...parts);
  }
}

export class DataItem {
  /**
   * One ANS-104 data item signed with an Arweave RSA key (signature type 1). Layout, all
   * integers little-endian:
   *   signature type (2) · signature (512) · owner (512)
   *   target: 1 presence byte, then 32 bytes if present · anchor: the same
   *   tag count (8) · tag bytes length (8) · tags (Avro) · data
   * The signature is RSA-PSS over a deep hash of
   * ["dataitem", "1", "1", owner, target, anchor, tags, data]; the id is SHA-256 of it.
   */
  static SIGNATURE_TYPE_ARWEAVE = 1;
  static SIGNATURE_LENGTH = 512;
  static OWNER_LENGTH = 512;

  constructor({ data, tags = [], target = new Uint8Array(0), anchor = new Uint8Array(0) }) {
    const encoder = new TextEncoder();
    this.data = data;
    this.tags = tags.map(([name, value]) => [encoder.encode(name), encoder.encode(value)]);
    this.target = target;
    this.anchor = anchor;
    if (![0, 32].includes(target.length) || ![0, 32].includes(anchor.length)) throw new Error('target and anchor must be empty or 32 bytes');
  }

  get tagBytes() {
    return AvroTags.encode(this.tags);
  }

  async signatureData(ownerBytes) {
    const encoder = new TextEncoder();
    return DeepHash.of([
      encoder.encode('dataitem'), encoder.encode('1'), encoder.encode(String(DataItem.SIGNATURE_TYPE_ARWEAVE)),
      ownerBytes, this.target, this.anchor, this.tagBytes, this.data,
    ]);
  }

  async sign(wallet) {
    if (wallet.ownerBytes.length !== DataItem.OWNER_LENGTH) throw new Error(`ANS-104 type 1 needs a 4096-bit RSA key; this one is ${wallet.ownerBytes.length * 8} bits`);
    this.ownerBytes = wallet.ownerBytes;
    this.signature = await wallet.sign(await this.signatureData(wallet.ownerBytes));
    this.id = Bytes.toBase64Url(Sha256.hash(this.signature));
    return this;
  }

  static littleEndian64(value) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    return bytes;
  }

  static optionalField(bytes) {
    return bytes.length ? Bytes.concat(new Uint8Array([1]), bytes) : new Uint8Array([0]);
  }

  /** The bytes a bundler accepts (POST /v1/tx, application/octet-stream). */
  toBytes() {
    if (!this.signature) throw new Error('sign the data item before serializing it');
    const tagBytes = this.tagBytes;
    return Bytes.concat(
      new Uint8Array([DataItem.SIGNATURE_TYPE_ARWEAVE, 0]), this.signature, this.ownerBytes,
      DataItem.optionalField(this.target), DataItem.optionalField(this.anchor),
      DataItem.littleEndian64(this.tags.length), DataItem.littleEndian64(tagBytes.length), tagBytes, this.data);
  }

  /**
   * Reads a serialized item back and checks its signature, so a received or re-fetched
   * item can be confirmed as the one signed. Returns { valid, id, owner, tags, data }.
   */
  static async parseAndVerify(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0, true) !== DataItem.SIGNATURE_TYPE_ARWEAVE) throw new Error(`signature type ${view.getUint16(0, true)} is not Arweave's (1)`);
    let offset = 2;
    const take = (length) => bytes.subarray(offset, (offset += length));
    const signature = take(DataItem.SIGNATURE_LENGTH);
    const ownerBytes = take(DataItem.OWNER_LENGTH);
    const optional = () => (take(1)[0] === 1 ? take(32) : new Uint8Array(0));
    const target = optional();
    const anchor = optional();
    const tagCount = Number(view.getBigUint64(offset, true));
    const tagByteLength = Number(view.getBigUint64(offset + 8, true));
    offset += 16;
    const tagBytes = take(tagByteLength);
    const data = bytes.subarray(offset);
    const item = new DataItem({ data, target, anchor });
    // Signature checking needs only the encoded tags, kept as given.
    Object.defineProperty(item, 'tagBytes', { value: tagBytes });
    const publicKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', e: 'AQAB', n: Bytes.toBase64Url(ownerBytes) }, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify']);
    // Signers differ in PSS salt length: arweave-js in browsers uses 32 bytes, Node's crypto
    // (arbundles' ArweaveSigner) the maximum, key bytes - hash bytes - 2. WebCrypto checks one
    // length at a time, so both are tried.
    const message = await item.signatureData(ownerBytes);
    let valid = false;
    for (const saltLength of [32, ownerBytes.length - 32 - 2]) {
      if (await crypto.subtle.verify({ name: 'RSA-PSS', saltLength }, publicKey, signature, message)) { valid = true; break; }
    }
    return { valid, id: Bytes.toBase64Url(Sha256.hash(signature)), owner: Bytes.toBase64Url(ownerBytes), tagCount, data };
  }
}

export class TurboUploader {
  /**
   * Sends signed data items to ArDrive's Turbo bundler. Items up to FREE_BYTES are stored
   * without payment (docs.ar.io, "Upload Data"); larger ones need Turbo credits, which this
   * does not handle. The receipt Turbo returns is signed by Turbo; status can be polled.
   */
  static UPLOAD_URL = 'https://upload.ardrive.io';
  static FREE_BYTES = 100 * 1024;

  constructor({ uploadUrl = TurboUploader.UPLOAD_URL, timeoutMs = 60000 } = {}) {
    Object.assign(this, { uploadUrl, timeoutMs });
  }

  async upload(dataItem) {
    const bytes = dataItem.toBytes();
    const response = await fetch(`${this.uploadUrl}/v1/tx`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Turbo refused the ${bytes.length}-byte item: HTTP ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  async status(dataItemId) {
    const response = await fetch(`${this.uploadUrl}/v1/tx/${dataItemId}/status`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`status of ${dataItemId}: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  }
}
