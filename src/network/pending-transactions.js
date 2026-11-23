// src/network/pending-transactions.js — the transactions waiting at a node to go into a block
// (its mempool, "memory pool"), kept fresh in the background so a block can carry them the
// moment a solution is found, without waiting on hundreds of requests then.

export class PendingTransactionPool {
  /**
   * `source.get(path)` resolves a node's JSON (an ArweaveGateway or NodeClient adapter).
   * GET /tx/pending lists the waiting ids, highest priority first; GET /unconfirmed_tx/{id}
   * gives each one's header. Headers are kept by id, so each refresh fetches only new ones.
   *
   * `maxHeld` caps how many are kept (a block may carry 1000; most blocks carry under 20).
   * `concurrency` is how many headers are fetched at once.
   */
  constructor({ source, maxHeld = 300, concurrency = 6, log = () => {} }) {
    Object.assign(this, { source, maxHeld, concurrency, log });
    this.headersById = new Map();
    this.pendingIds = [];
    this.refreshing = null;
  }

  /**
   * Fetches the pending list and any headers not yet held; drops ones no longer pending.
   * Resolves { pending, held, fetched, failed }. A refresh already running is shared.
   */
  refresh() {
    this.refreshing ??= this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refreshOnce() {
    const pendingIds = await this.source.get('/tx/pending');
    if (!Array.isArray(pendingIds)) throw new Error('/tx/pending did not answer with a list of ids');
    this.pendingIds = pendingIds.slice(0, this.maxHeld);
    const wanted = new Set(this.pendingIds);
    for (const id of this.headersById.keys()) if (!wanted.has(id)) this.headersById.delete(id);

    const missing = this.pendingIds.filter((id) => !this.headersById.has(id));
    let failed = 0;
    const fetchNext = async () => {
      while (missing.length) {
        const id = missing.shift();
        try {
          this.headersById.set(id, PendingTransactionPool.header(await this.source.get(`/unconfirmed_tx/${id}`)));
        } catch (error) {
          // Usually mined (or dropped) since the list was read; it leaves the list next time.
          failed++;
          if (failed <= 3) this.log(`pending transaction ${id} not fetched: ${error.message.slice(0, 200)}`);
        }
      }
    };
    const fetchedBefore = this.headersById.size;
    await Promise.all(Array.from({ length: this.concurrency }, fetchNext));
    return { pending: pendingIds.length, held: this.headersById.size, fetched: this.headersById.size - fetchedBefore, failed };
  }

  /**
   * The header a block carries: a format-2 transaction's data travels apart from the block
   * (its signature covers only the data root), so any inline data is dropped.
   */
  static header(json) {
    return Number(json.format) === 2 && json.data ? { ...json, data: '' } : json;
  }

  /** The held headers, in the node's priority order: candidates for TransactionPicker.pick. */
  candidates() {
    return this.pendingIds.map((id) => this.headersById.get(id)).filter(Boolean);
  }
}
