// src/storage/browser-object-store.js — one IndexedDB object store, opened on first use. The
// browser may refuse storage (private windows, blocked site data) or clear it under disk
// pressure; every transaction then fails softly (logged, resolving undefined), so callers
// keep working from memory.

export class BrowserObjectStore {
  /** `databaseName` holds just this one store, so stores never need version upgrades together. */
  constructor({ databaseName, storeName, log = () => {} }) {
    Object.assign(this, { databaseName, storeName, log });
    this.databasePromise = null;
  }

  open() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('this browser has no IndexedDB'));
          return;
        }
        const request = indexedDB.open(this.databaseName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(this.storeName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'));
      });
    }
    return this.databasePromise;
  }

  /**
   * Runs `action(objectStore)` in one transaction; resolves the `value` of the object
   * `action` returns, once the transaction completes (requests fill it in meanwhile), or
   * undefined if storage failed.
   */
  async transaction(mode, action) {
    try {
      const database = await this.open();
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(this.storeName, mode);
        const result = action(transaction.objectStore(this.storeName));
        transaction.oncomplete = () => resolve(result.value);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('storage transaction aborted'));
      });
    } catch (error) {
      this.log(`browser storage unavailable: ${error.message}`);
      return undefined;
    }
  }

  /** The value under `key`, or undefined (also when storage failed). */
  async get(key) {
    return this.transaction('readonly', (store) => {
      const result = { value: undefined };
      const request = store.get(key);
      request.onsuccess = () => { result.value = request.result; };
      return result;
    });
  }

  /** Closes the connection, if open (deleting the database waits until every one is closed). */
  async close() {
    const database = await this.databasePromise?.catch(() => null);
    database?.close();
    this.databasePromise = null;
  }

  /** Stores `value` under `key`; resolves whether it was saved. */
  async put(key, value) {
    return (await this.transaction('readwrite', (store) => {
      store.put(value, key);
      return { value: true };
    })) === true;
  }
}
