// src/storage/saved-chunk-index.js — which packed chunks are saved, per mining address, kept
// beside them as bitmaps (BucketSet pages), so startup and the saved-address list read a few
// small records instead of listing every key (minutes at a full partition).

import { BrowserObjectStore } from './browser-object-store.js';
import { BucketSet } from '../mining/bucket-set.js';
import { HeldStorage } from '../mining/held-storage.js';

export class SavedChunkIndex extends BrowserObjectStore {
  /**
   * Records, in a database of their own: "<address>:page:<n>" → one BucketSet page,
   * "<address>:unaligned" → the end offsets (as text) of chunks below the strict data split
   * threshold, and "built" → true once every saved chunk is indexed (data saved before the
   * index existed is indexed once, by listing it: see PackedChunkStore.indexes).
   *
   * Chunks are saved first and indexed after, in a separate database, so the index may
   * miss a chunk (a stopped save: the chunk is then only unused space) but never names one
   * that was not saved.
   */
  static DATABASE_NAME = 'weave-tab-miner-index';
  static STORE_NAME = 'saved-chunks';
  static BUILT_KEY = 'built';

  constructor({ log = () => {} } = {}) {
    super({ databaseName: SavedChunkIndex.DATABASE_NAME, storeName: SavedChunkIndex.STORE_NAME, log });
  }

  /** An empty index for one address: { buckets: BucketSet, unalignedEnds: Set of text }. */
  static emptyEntry() {
    return { buckets: new BucketSet(), unalignedEnds: new Set() };
  }

  /** Adds an end offset to an entry; returns the page number it touched, or 'unaligned', or null if already there. */
  static addEnd(entry, end) {
    const bucketNumber = HeldStorage.bucketNumber(end);
    if (bucketNumber === null) {
      if (entry.unalignedEnds.has(end.toString())) return null;
      entry.unalignedEnds.add(end.toString());
      return 'unaligned';
    }
    return entry.buckets.add(bucketNumber) ? BucketSet.locate(bucketNumber).page : null;
  }

  /** Every address's index, or null when it was never built: Map address → entry. */
  async loadAll() {
    const loaded = await this.transaction('readonly', (store) => {
      const result = { value: { built: false, entries: new Map() } };
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if (key === SavedChunkIndex.BUILT_KEY) {
          result.value.built = true;
        } else {
          const [address, kind, page] = key.split(':');
          const entry = result.value.entries.get(address) ?? { pages: [], unalignedEnds: [] };
          result.value.entries.set(address, entry);
          if (kind === 'page') entry.pages.push([Number(page), new Uint8Array(cursor.value)]);
          else entry.unalignedEnds = cursor.value;
        }
        cursor.continue();
      };
      return result;
    });
    if (!loaded?.built) return null;
    return new Map([...loaded.entries].map(([address, { pages, unalignedEnds }]) => [address, { buckets: BucketSet.fromPages(pages), unalignedEnds: new Set(unalignedEnds) }]));
  }

  /** Writes the named pages (and the unaligned list, if named) of one address's entry. Resolves whether saved. */
  async write(address, entry, touched) {
    const saved = await this.transaction('readwrite', (store) => {
      for (const page of touched) {
        if (page === 'unaligned') store.put([...entry.unalignedEnds], `${address}:unaligned`);
        else store.put(entry.buckets.pages.get(page), `${address}:page:${page}`);
      }
      return { value: true };
    });
    return saved === true;
  }

  /** Writes whole entries and marks the index built (after listing older data). */
  async writeAll(entries) {
    const saved = await this.transaction('readwrite', (store) => {
      for (const [address, entry] of entries) {
        for (const [page, bits] of entry.buckets.pagesForSaving()) store.put(bits, `${address}:page:${page}`);
        if (entry.unalignedEnds.size) store.put([...entry.unalignedEnds], `${address}:unaligned`);
      }
      store.put(true, SavedChunkIndex.BUILT_KEY);
      return { value: true };
    });
    return saved === true;
  }

  async deleteAddress(address) {
    const removed = await this.transaction('readwrite', (store) => {
      store.delete(IDBKeyRange.bound(`${address}:`, `${address}:￿`));
      return { value: true };
    });
    return removed === true;
  }
}
