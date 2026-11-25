// src/storage/chunk-store.js — keeps packed chunks in the browser's IndexedDB, so packing (about
// 30 seconds per batch of entropies) survives closing and reopening the browser.

import { BrowserObjectStore } from './browser-object-store.js';

export class PackedChunkStore extends BrowserObjectStore {
  /**
   * One IndexedDB object store of packed chunks, keyed by "<mining address>:<bucket end
   * offset>". Packing is bound to the address, so each address has its own set.
   * Storage failures are soft (see BrowserObjectStore): the miner keeps working from memory.
   */
  static DATABASE_NAME = 'weave-tab-miner';
  static STORE_NAME = 'packed-chunks';

  constructor({ log = () => {} } = {}) {
    super({ databaseName: PackedChunkStore.DATABASE_NAME, storeName: PackedChunkStore.STORE_NAME, log });
  }

  static key(address, bucketEndOffset) {
    return `${address}:${bucketEndOffset}`;
  }

  /** Save packed chunks: [[bucketEndOffset, Uint8Array(256 KiB)], ...]. Returns true if saved. */
  async save(address, entries) {
    const saved = await this.transaction('readwrite', (store) => {
      for (const [bucketEndOffset, packedChunk] of entries) store.put(packedChunk, PackedChunkStore.key(address, bucketEndOffset));
      return { value: true };
    });
    return saved === true;
  }

  /** Removes every chunk saved for an address. Returns true if removed. */
  async deleteAddress(address) {
    const removed = await this.transaction('readwrite', (store) => {
      store.delete(IDBKeyRange.bound(`${address}:`, `${address}:\uffff`));
      return { value: true };
    });
    return removed === true;
  }

  /** The offsets saved for an address, without their bytes: [BigInt], ascending as text. */
  async offsets(address) {
    const offsets = await this.transaction('readonly', (store) => {
      const result = { value: [] };
      const cursorRequest = store.openKeyCursor(IDBKeyRange.bound(`${address}:`, `${address}:\uffff`));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        result.value.push(BigInt(String(cursor.key).slice(address.length + 1)));
        cursor.continue();
      };
      return result;
    });
    return offsets ?? [];
  }

  /** Some of an address's chunks: [[offset, Uint8Array]] for the offsets found. */
  async loadSome(address, offsets) {
    const entries = await this.transaction('readonly', (store) => {
      const result = { value: [] };
      for (const offset of offsets) {
        const request = store.get(PackedChunkStore.key(address, offset));
        request.onsuccess = () => { if (request.result) result.value.push([BigInt(offset), new Uint8Array(request.result)]); };
      }
      return result;
    });
    return entries ?? [];
  }

  /** One chunk, or null if not saved. */
  async loadOne(address, offset) {
    const [entry] = await this.loadSome(address, [offset]);
    return entry ? entry[1] : null;
  }

  /** All packed chunks saved for an address, as [[bucketEndOffset (BigInt), Uint8Array], ...]. */
  async load(address) {
    const entries = await this.transaction('readonly', (store) => {
      const result = { value: [] };
      const range = IDBKeyRange.bound(`${address}:`, `${address}:￿`);
      const cursorRequest = store.openCursor(range);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        result.value.push([BigInt(cursor.key.slice(address.length + 1)), new Uint8Array(cursor.value)]);
        cursor.continue();
      };
      return result;
    });
    return entries ?? [];
  }

  /** Every address with saved chunks, and how many: [{ address, chunkCount }], by address. */
  async addresses() {
    const counts = await this.transaction('readonly', (store) => {
      const result = { value: new Map() };
      const cursorRequest = store.openKeyCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const address = String(cursor.key).split(':')[0];
        result.value.set(address, (result.value.get(address) ?? 0) + 1);
        cursor.continue();
      };
      return result;
    });
    return [...(counts ?? new Map())].map(([address, chunkCount]) => ({ address, chunkCount }));
  }

  /** Ask the browser not to clear this site's data under disk pressure. Returns whether granted. */
  static async requestPersistence() {
    try {
      return Boolean(await navigator.storage?.persist?.());
    } catch {
      return false;
    }
  }

  /**
   * Asks the browser to keep this site's storage (navigator.storage.persist), so it is not
   * cleared when the disk runs low; Firefox also raises the site's limit from 10 GiB to up
   * to half the free disk. Chrome decides silently, Firefox may ask the person. Resolves
   * whether storage is kept, or null where the browser has no such setting.
   */
  static async persist() {
    try {
      if (!navigator.storage?.persist) return null;
      return (await navigator.storage.persisted()) || (await navigator.storage.persist());
    } catch {
      return null;
    }
  }

  /** Bytes used and available to this site, if the browser says. */
  static async estimate() {
    try {
      return (await navigator.storage?.estimate?.()) ?? null;
    } catch {
      return null;
    }
  }
}

export class PackedChunkArchive {
  /**
   * A file of packed chunks for one address, to move them between browsers or machines
   * without packing again. Layout: one text line naming the format, one line of JSON
   * { address, chunkSize, bucketEndOffsets: [string] }, then the chunks back to back in
   * that order, each exactly chunkSize bytes.
   *
   * Packed chunks are only useful for the address they were packed for; importing checks
   * nothing else about them (a damaged chunk just never yields a valid solution).
   */
  static FORMAT_LINE = 'weave-tab-miner packed chunks v1';
  static CHUNK_SIZE = 262144;

  /** A Blob ready to download; `entries` is [[bucketEndOffset, Uint8Array], ...]. */
  static toBlob(address, entries) {
    return new Blob([PackedChunkArchive.header(address, entries.map(([offset]) => offset)), ...entries.map(([offset, chunk]) => PackedChunkArchive.checkedChunk(offset, chunk))], { type: 'application/octet-stream' });
  }

  /** The archive's two header lines, for chunks at `offsets` in that order. */
  static header(address, offsets) {
    return `${PackedChunkArchive.FORMAT_LINE}\n${JSON.stringify({ address, chunkSize: PackedChunkArchive.CHUNK_SIZE, bucketEndOffsets: offsets.map(String) })}\n`;
  }

  static checkedChunk(offset, chunk) {
    if (chunk?.length !== PackedChunkArchive.CHUNK_SIZE) throw new Error(`chunk at ${offset} is ${chunk?.length ?? 'missing'}, not ${PackedChunkArchive.CHUNK_SIZE} bytes`);
    return chunk;
  }

  /**
   * The archive as parts in order (the header, then batches of chunks as Blobs), reading
   * `batchSize` chunks at a time through `readBatch(offsets)` → [[offset, chunk], ...], so a
   * large archive never sits in memory whole. `onProgress(done, total)` follows it.
   */
  static async *parts(address, offsets, readBatch, { batchSize = 128, onProgress = () => {} } = {}) {
    yield PackedChunkArchive.header(address, offsets);
    for (let start = 0; start < offsets.length; start += batchSize) {
      const wanted = offsets.slice(start, start + batchSize);
      const byOffset = new Map((await readBatch(wanted)).map(([offset, chunk]) => [String(offset), chunk]));
      yield new Blob(wanted.map((offset) => PackedChunkArchive.checkedChunk(offset, byOffset.get(String(offset)))));
      onProgress(Math.min(start + batchSize, offsets.length), offsets.length);
    }
  }

  static fileName(address, chunkCount) {
    return `weave-chunks-${address.slice(0, 8)}-${chunkCount}.bin`;
  }

  /**
   * Reads an archive back in batches: yields { address, entries } of up to `batchSize`
   * chunks, one slice of the file at a time, so a large file is never held whole. Throws
   * with the reason if the file is not an archive.
   */
  static async *batches(blob, { batchSize = 128 } = {}) {
    const headStart = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 1 << 24).arrayBuffer()));
    const firstBreak = headStart.indexOf('\n');
    const secondBreak = headStart.indexOf('\n', firstBreak + 1);
    if (headStart.slice(0, firstBreak) !== PackedChunkArchive.FORMAT_LINE || secondBreak < 0) throw new Error('not a packed chunk archive from this page');
    const header = JSON.parse(headStart.slice(firstBreak + 1, secondBreak));
    const dataStart = new TextEncoder().encode(headStart.slice(0, secondBreak + 1)).length;
    const expectedSize = dataStart + header.bucketEndOffsets.length * header.chunkSize;
    if (blob.size !== expectedSize) throw new Error(`archive is ${blob.size} bytes; its header promises ${expectedSize} (an unfinished download?)`);
    for (let first = 0; first < header.bucketEndOffsets.length; first += batchSize) {
      const offsets = header.bucketEndOffsets.slice(first, first + batchSize);
      const start = dataStart + first * header.chunkSize;
      const bytes = new Uint8Array(await blob.slice(start, start + offsets.length * header.chunkSize).arrayBuffer());
      yield { address: header.address, entries: offsets.map((offset, index) => [BigInt(offset), bytes.slice(index * header.chunkSize, (index + 1) * header.chunkSize)]) };
    }
  }

  /** The whole archive read back: { address, entries }. For small archives; see `batches`. */
  static async fromBlob(blob) {
    let address = null;
    const entries = [];
    for await (const batch of PackedChunkArchive.batches(blob)) {
      address = batch.address;
      entries.push(...batch.entries);
    }
    return { address, entries };
  }
}
