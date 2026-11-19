// src/blocks/signing-guard.js — refuses to sign a block that would count as double signing, so a
// key shared by many tabs is not banned by an honest mistake.
//
// Arweave bans an address (its locked rewards lost, never to mine again) when anyone shows
// two signatures by its key whose cumulative difficulties satisfy
//   CDiff1 == CDiff2  or  (CDiff1 > PrevCDiff2 and CDiff2 > PrevCDiff1)
// (ar_block.erl get_double_signing_condition; applied in ar_node_utils.erl
// may_be_apply_double_signing_proof). In plain words: two blocks competing for the same
// place in the chain. This guard remembers what a key has signed and refuses a second
// such signature. It deters accidents only: anyone holding the key can still sign
// whatever they like, and other tabs sharing the key keep their own records.

export class DoubleSigningGuard {
  /**
   * `storage` is anything with getItem/setItem (localStorage in a page, a Map-backed
   * stand-in elsewhere). Records are kept per address, newest last, up to `keepRecords`.
   */
  static STORAGE_PREFIX = 'weave-tab-miner.signed-blocks.';

  constructor({ storage, keepRecords = 1000 }) {
    Object.assign(this, { storage, keepRecords });
  }

  static conflicts(first, second) {
    return first.cumulativeDiff === second.cumulativeDiff
      || (first.cumulativeDiff > second.previousCumulativeDiff && second.cumulativeDiff > first.previousCumulativeDiff);
  }

  records(address) {
    try {
      return JSON.parse(this.storage.getItem(DoubleSigningGuard.STORAGE_PREFIX + address) ?? '[]')
        .map((record) => ({ ...record, cumulativeDiff: BigInt(record.cumulativeDiff), previousCumulativeDiff: BigInt(record.previousCumulativeDiff) }));
    } catch {
      // Unreadable records: treat as none, but the caller is told nothing is remembered.
      return [];
    }
  }

  /**
   * Returns null if signing { height, cumulativeDiff, previousCumulativeDiff, blockHash }
   * is safe by this key's records, or the earlier record it would conflict with. Signing
   * the very same block again (same hash) is allowed: it is one block, not two.
   */
  conflictFor(address, candidate) {
    return this.records(address).find((record) => record.blockHash !== candidate.blockHash && DoubleSigningGuard.conflicts(record, candidate)) ?? null;
  }

  /** Remembers a signature. Call only after conflictFor returned null. */
  record(address, { height, cumulativeDiff, previousCumulativeDiff, blockHash }) {
    const kept = [...this.records(address), { height, cumulativeDiff, previousCumulativeDiff, blockHash }].slice(-this.keepRecords);
    this.storage.setItem(DoubleSigningGuard.STORAGE_PREFIX + address,
      JSON.stringify(kept.map((entry) => ({ ...entry, cumulativeDiff: entry.cumulativeDiff.toString(), previousCumulativeDiff: entry.previousCumulativeDiff.toString() }))));
  }
}
