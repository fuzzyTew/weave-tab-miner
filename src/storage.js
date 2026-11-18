// src/storage.js — keeps packed chunks in the browser's IndexedDB, so packing (about
// 30 seconds per batch of entropies) survives closing and reopening the browser.

export class PackedChunkStore {
  /**
   * One IndexedDB object store of packed chunks, keyed by "<mining address>:<bucket end
   * offset>". Packing is bound to the address, so each address has its own set.
   *
   * The browser may refuse storage (private windows, blocked site data) or clear it under
   * disk pressure; every method then fails softly and the miner keeps working from memory.
   */
  static DATABASE_NAME = 'weave-tab-miner';
  static STORE_NAME = 'packed-chunks';

  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.databasePromise = null;
  }

  static key(address, bucketEndOffset) {
    return `${address}:${bucketEndOffset}`;
  }

  open() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('this browser has no IndexedDB'));
          return;
        }
        const request = indexedDB.open(PackedChunkStore.DATABASE_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(PackedChunkStore.STORE_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'));
      });
    }
    return this.databasePromise;
  }

  async transaction(mode, action) {
    try {
      const database = await this.open();
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(PackedChunkStore.STORE_NAME, mode);
        const result = action(transaction.objectStore(PackedChunkStore.STORE_NAME));
        transaction.oncomplete = () => resolve(result.value);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('storage transaction aborted'));
      });
    } catch (error) {
      this.log(`browser storage unavailable: ${error.message}`);
      return undefined;
    }
  }

  /** Save packed chunks: [[bucketEndOffset, Uint8Array(256 KiB)], ...]. Returns true if saved. */
  async save(address, entries) {
    const saved = await this.transaction('readwrite', (store) => {
      for (const [bucketEndOffset, packedChunk] of entries) store.put(packedChunk, PackedChunkStore.key(address, bucketEndOffset));
      return { value: true };
    });
    return saved === true;
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
    const header = { address, chunkSize: PackedChunkArchive.CHUNK_SIZE, bucketEndOffsets: entries.map(([offset]) => offset.toString()) };
    for (const [offset, chunk] of entries) {
      if (chunk.length !== PackedChunkArchive.CHUNK_SIZE) throw new Error(`chunk at ${offset} is ${chunk.length} bytes, not ${PackedChunkArchive.CHUNK_SIZE}`);
    }
    return new Blob([`${PackedChunkArchive.FORMAT_LINE}\n${JSON.stringify(header)}\n`, ...entries.map(([, chunk]) => chunk)], { type: 'application/octet-stream' });
  }

  static fileName(address, chunkCount) {
    return `weave-chunks-${address.slice(0, 8)}-${chunkCount}.bin`;
  }

  /**
   * Reads an archive back: { address, entries }. Reads the chunks one slice at a time, so a
   * large file is not copied whole. Throws with the reason if the file is not an archive.
   */
  static async fromBlob(blob) {
    const headStart = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer()));
    const firstBreak = headStart.indexOf('\n');
    const secondBreak = headStart.indexOf('\n', firstBreak + 1);
    if (headStart.slice(0, firstBreak) !== PackedChunkArchive.FORMAT_LINE || secondBreak < 0) throw new Error('not a packed chunk archive from this page');
    const header = JSON.parse(headStart.slice(firstBreak + 1, secondBreak));
    const dataStart = new TextEncoder().encode(headStart.slice(0, secondBreak + 1)).length;
    const expectedSize = dataStart + header.bucketEndOffsets.length * header.chunkSize;
    if (blob.size !== expectedSize) throw new Error(`archive is ${blob.size} bytes; its header promises ${expectedSize}`);
    const entries = [];
    for (const [index, offset] of header.bucketEndOffsets.entries()) {
      const start = dataStart + index * header.chunkSize;
      entries.push([BigInt(offset), new Uint8Array(await blob.slice(start, start + header.chunkSize).arrayBuffer())]);
    }
    return { address: header.address, entries };
  }
}
