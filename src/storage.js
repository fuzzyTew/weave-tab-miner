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
