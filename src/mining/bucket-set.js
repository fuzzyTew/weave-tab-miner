// src/mining/bucket-set.js — a set of bucket numbers kept as bitmaps: one bit per 256 KiB
// bucket, so a full partition (about 13.7 million buckets) takes 1.7 MB, where one string
// key apiece took about 1.1 GB.

export class BucketSet {
  /**
   * Non-negative integers (bucket numbers) in pages of PAGE_BITS bits, made as first used,
   * so a set spread over the weave costs only the pages it touches. Pages are plain
   * Uint8Arrays, so a set can be saved and rebuilt page by page (pages, fromPages).
   */
  static PAGE_BITS = 2 ** 20; // 128 KiB a page, covering 256 GiB of buckets

  constructor() {
    this.pages = new Map(); // page number -> Uint8Array(PAGE_BITS / 8)
    this.size = 0;
  }

  static locate(bucketNumber) {
    const page = Math.floor(bucketNumber / BucketSet.PAGE_BITS);
    const bit = bucketNumber - page * BucketSet.PAGE_BITS;
    return { page, byte: bit >> 3, mask: 1 << (bit & 7) };
  }

  has(bucketNumber) {
    const { page, byte, mask } = BucketSet.locate(bucketNumber);
    return Boolean(this.pages.get(page)?.[byte] & mask);
  }

  /** Adds it; returns true when it was not there before. */
  add(bucketNumber) {
    const { page, byte, mask } = BucketSet.locate(bucketNumber);
    let bits = this.pages.get(page);
    if (!bits) this.pages.set(page, bits = new Uint8Array(BucketSet.PAGE_BITS / 8));
    if (bits[byte] & mask) return false;
    bits[byte] |= mask;
    this.size++;
    return true;
  }

  /** Members from `low` up to but not including `high`, ascending. Skips empty bytes eight at a time. */
  *ascending(low = 0, high = Infinity) {
    const pageNumbers = [...this.pages.keys()].sort((left, right) => left - right);
    for (const page of pageNumbers) {
      const pageStart = page * BucketSet.PAGE_BITS;
      if (pageStart >= high || pageStart + BucketSet.PAGE_BITS <= low) continue;
      const bits = this.pages.get(page);
      const firstByte = Math.max(0, (low - pageStart) >> 3);
      for (let byte = firstByte; byte < bits.length; byte++) {
        if (!bits[byte]) continue;
        for (let bit = 0; bit < 8; bit++) {
          if (!(bits[byte] & (1 << bit))) continue;
          const member = pageStart + byte * 8 + bit;
          if (member >= high) return;
          if (member >= low) yield member;
        }
      }
    }
  }

  /** Adds every member of `other` (page by page, a bitwise or). */
  addAll(other) {
    for (const [page, otherBits] of other.pages) {
      let bits = this.pages.get(page);
      if (!bits) this.pages.set(page, bits = new Uint8Array(BucketSet.PAGE_BITS / 8));
      for (let byte = 0; byte < otherBits.length; byte++) {
        if (!otherBits[byte]) continue;
        this.size += BucketSet.bitCount(otherBits[byte] & ~bits[byte]);
        bits[byte] |= otherBits[byte];
      }
    }
  }

  /** How many members lie from `low` up to but not including `high`. */
  countBetween(low, high) {
    let count = 0;
    for (const [page, bits] of this.pages) {
      const pageStart = page * BucketSet.PAGE_BITS;
      const from = Math.max(low, pageStart) - pageStart;
      const to = Math.min(high, pageStart + BucketSet.PAGE_BITS) - pageStart;
      if (from >= to) continue;
      // Whole bytes counted a byte at a time; the partial ones at either end bit by bit.
      let bit = from;
      for (; bit < to && (bit & 7); bit++) if (bits[bit >> 3] & (1 << (bit & 7))) count++;
      for (; bit + 8 <= to; bit += 8) count += BucketSet.bitCount(bits[bit >> 3]);
      for (; bit < to; bit++) if (bits[bit >> 3] & (1 << (bit & 7))) count++;
    }
    return count;
  }

  /** The pages, for saving: [[page number, Uint8Array]]. */
  pagesForSaving() {
    return [...this.pages];
  }

  static fromPages(pages) {
    const set = new BucketSet();
    for (const [page, bits] of pages) {
      set.pages.set(page, bits);
      for (const byte of bits) set.size += BucketSet.bitCount(byte);
    }
    return set;
  }

  static bitCount(byte) {
    let count = 0;
    for (let rest = byte; rest; rest &= rest - 1) count++;
    return count;
  }
}
