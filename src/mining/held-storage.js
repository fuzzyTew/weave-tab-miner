// src/mining/held-storage.js — The packed chunks a node holds, kept on disk and read in as steps need them.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { ConsensusConstants } from '../core/constants.js';
import { Replica29Layout } from './packing.js';
import { BucketSet } from './bucket-set.js';

export class HeldStorage {
  /**
   * The packed chunks this node holds, keyed by end offset (Replica29Layout.storedEndOffset:
   * the bucket's end above the strict data split threshold, the chunk's own end below it,
   * where chunks do not fill whole buckets), each one 256 KiB buffer of 32 packed
   * sub-chunks. A real node keeps terabytes on disk; a tab keeps what its browser storage
   * allows (see src/storage/chunk-store.js).
   *
   * Which chunks are held is kept compactly: above the threshold, one bit per bucket
   * (BucketSet); below it, a sorted list of ends (rare: mining there is not yet seen).
   * Only some chunks need to be in memory. Given `loadChunk(endOffset) →
   * Promise<Uint8Array|null>`, chunks saved somewhere loadChunk can read leave memory
   * beyond `residentLimit`, least recently used first, and are read back when a step needs
   * them (ensureLoaded). Chunks not yet saved never leave. Without a loader everything
   * stays in memory.
   */
  constructor({ loadChunk = null, residentLimit = 64 } = {}) {
    this.loadChunk = loadChunk;
    this.residentLimit = residentLimit;
    this.alignedBuckets = new BucketSet(); // bucket numbers above the threshold
    this.unalignedEnds = []; // held end offsets at or below the threshold, ascending (BigInt)
    this.inMemory = new Map(); // key -> Uint8Array, least recently used first
    this.unsaved = new Set(); // keys in memory that loadChunk cannot read back
    // Kept as chunks arrive, so counts cost O(1) however much is held.
    this.bytesByPartition = new Map(); // partition number -> bytes held in it
    this.changeCount = 0; // grows whenever a chunk is added; caches compare it
  }

  /** The bucket number of an end offset above the threshold, or null below it. */
  static bucketNumber(end) {
    const threshold = ConsensusConstants.STRICT_DATA_SPLIT_THRESHOLD;
    if (end <= threshold) return null;
    return Number((end - threshold) / BigInt(ConsensusConstants.DATA_CHUNK_SIZE)) - 1;
  }

  /** The end offset of bucket `bucketNumber` (above the threshold). */
  static bucketEnd(bucketNumber) {
    return ConsensusConstants.STRICT_DATA_SPLIT_THRESHOLD + BigInt(bucketNumber + 1) * BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
  }

  /** Whether the chunk with this key (end offset as text) is held, in memory or not. */
  holds(key) {
    const end = BigInt(key);
    const bucketNumber = HeldStorage.bucketNumber(end);
    if (bucketNumber !== null) return this.alignedBuckets.has(bucketNumber);
    const index = this.firstEndAfter(end - 1n);
    return this.unalignedEnds[index] === end;
  }

  /** Notes a held end offset; returns true when it was not held before. */
  noteHeld(key) {
    const end = BigInt(key);
    const bucketNumber = HeldStorage.bucketNumber(end);
    if (bucketNumber !== null) {
      if (!this.alignedBuckets.add(bucketNumber)) return false;
    } else {
      const index = this.firstEndAfter(end - 1n);
      if (this.unalignedEnds[index] === end) return false;
      this.unalignedEnds.splice(index, 0, end);
    }
    const partitionNumber = Number((end - 1n) / ConsensusConstants.PARTITION_SIZE);
    this.bytesByPartition.set(partitionNumber, (this.bytesByPartition.get(partitionNumber) ?? 0) + ConsensusConstants.DATA_CHUNK_SIZE);
    this.changeCount++;
    return true;
  }

  /** The index of the first unaligned end offset past `weaveByte` (a binary search). */
  firstEndAfter(weaveByte) {
    let low = 0;
    let high = this.unalignedEnds.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.unalignedEnds[middle] > weaveByte) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  /**
   * The key of the held chunk holding `weaveByte`, or null if none is held: its bucket's
   * end above the threshold; below it, the first held end past the byte, if within a
   * chunk's size (chunks there are contiguous, so that one holds the byte).
   */
  keyForByte(weaveByte) {
    if (weaveByte >= ConsensusConstants.STRICT_DATA_SPLIT_THRESHOLD) {
      const end = Replica29Layout.bucketEndOffsetForByte(weaveByte);
      return this.alignedBuckets.has(HeldStorage.bucketNumber(end)) ? end.toString() : null;
    }
    const end = this.unalignedEnds[this.firstEndAfter(weaveByte)];
    if (end !== undefined && end - weaveByte <= BigInt(ConsensusConstants.DATA_CHUNK_SIZE)) return end.toString();
    return null;
  }

  add(endOffset, packedChunk, { reloadable = false } = {}) {
    const key = endOffset.toString();
    this.noteHeld(key);
    if (reloadable) this.unsaved.delete(key);
    else this.unsaved.add(key);
    this.remember(key, packedChunk);
  }

  /**
   * Every chunk in a saved index ({ buckets: BucketSet, unalignedEnds: iterable of end
   * offsets }, as SavedChunkIndex keeps them), known by offset only until needed: a whole
   * partition is merged page by page, not chunk by chunk.
   */
  addSavedIndex({ buckets, unalignedEnds }) {
    for (const end of unalignedEnds) this.noteHeld(String(end));
    this.alignedBuckets.addAll(buckets);
    this.recountPartitions();
  }

  /** Recomputes bytes held per partition from the index (after a merge). */
  recountPartitions() {
    const chunk = ConsensusConstants.DATA_CHUNK_SIZE;
    const counts = new Map();
    for (const end of this.unalignedEnds) {
      const partitionNumber = Number((end - 1n) / ConsensusConstants.PARTITION_SIZE);
      counts.set(partitionNumber, (counts.get(partitionNumber) ?? 0) + chunk);
    }
    const partitionNumbers = new Set();
    for (const page of this.alignedBuckets.pages.keys()) {
      const firstEnd = HeldStorage.bucketEnd(page * BucketSet.PAGE_BITS);
      const lastEnd = HeldStorage.bucketEnd((page + 1) * BucketSet.PAGE_BITS - 1);
      for (let partitionNumber = Number((firstEnd - 1n) / ConsensusConstants.PARTITION_SIZE); partitionNumber <= Number((lastEnd - 1n) / ConsensusConstants.PARTITION_SIZE); partitionNumber++) partitionNumbers.add(partitionNumber);
    }
    for (const partitionNumber of partitionNumbers) {
      const [low, high] = HeldStorage.bucketRangeOfPartition(partitionNumber);
      const bytes = this.alignedBuckets.countBetween(low, high) * chunk + (counts.get(partitionNumber) ?? 0);
      if (bytes) counts.set(partitionNumber, bytes);
    }
    this.bytesByPartition = counts;
    this.changeCount++;
  }

  /** Bucket numbers [low, high) whose chunks end in partition `partitionNumber` (empty below the threshold). */
  static bucketRangeOfPartition(partitionNumber) {
    const partitionStart = BigInt(partitionNumber) * ConsensusConstants.PARTITION_SIZE;
    const partitionEnd = partitionStart + ConsensusConstants.PARTITION_SIZE;
    const threshold = ConsensusConstants.STRICT_DATA_SPLIT_THRESHOLD;
    if (partitionEnd <= threshold) return [0, 0];
    const chunk = BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
    // Bucket b ends at threshold + (b + 1) * chunk: the lowest b ending past partitionStart, up to the highest ending at partitionEnd.
    const low = partitionStart <= threshold ? 0 : Number((partitionStart - threshold) / chunk);
    return [low, Number((partitionEnd - threshold) / chunk)];
  }

  /** A chunk saved where loadChunk can read it, known by offset only until needed. */
  addOnDisk(endOffset) {
    const key = endOffset.toString();
    if (this.inMemory.has(key)) return;
    this.noteHeld(key);
  }

  /** Marks chunks as saved, so they may leave memory. */
  markReloadable(endOffsets) {
    for (const offset of endOffsets) this.unsaved.delete(offset.toString());
    this.evictBeyondLimit();
  }

  /** Keeps a chunk in memory as the most recently used. */
  remember(key, packedChunk) {
    this.inMemory.delete(key);
    this.inMemory.set(key, packedChunk);
    this.evictBeyondLimit();
  }

  evictBeyondLimit() {
    if (!this.loadChunk) return;
    for (const key of this.inMemory.keys()) {
      if (this.inMemory.size <= this.residentLimit) break;
      if (!this.unsaved.has(key)) this.inMemory.delete(key);
    }
  }

  /**
   * Brings the chunks holding these weave bytes into memory, where held, reading those on
   * disk in parallel. Resolves the number read from disk. Callers should ask for no more
   * than `residentLimit` chunks at once, or the first may leave memory again before use.
   */
  async ensureLoaded(weaveBytes) {
    const keys = [...new Set(weaveBytes.map((byte) => this.keyForByte(byte)))].filter((key) => key !== null);
    const onDisk = keys.filter((key) => !this.inMemory.has(key) && this.loadChunk);
    const read = await Promise.all(onDisk.map((key) => this.loadChunk(BigInt(key))));
    onDisk.forEach((key, index) => {
      if (read[index]) this.inMemory.set(key, read[index]);
    });
    for (const key of keys) {
      const chunk = this.inMemory.get(key);
      if (chunk) this.remember(key, chunk);
    }
    return read.filter(Boolean).length;
  }

  get residentCount() {
    return this.inMemory.size;
  }

  /** The packed chunk holding `weaveByte`, if held and in memory; else null. */
  chunkForByte(weaveByte) {
    const key = this.keyForByte(weaveByte);
    return key === null ? null : this.inMemory.get(key) ?? null;
  }

  /** Sub-chunk `subChunkIndex` of a packed chunk, or null for no chunk. */
  static subChunkOf(packed, subChunkIndex) {
    if (!packed) return null;
    const size = ConsensusConstants.SUB_CHUNK_SIZE;
    return packed.subarray(subChunkIndex * size, (subChunkIndex + 1) * size);
  }

  subChunkForByte(weaveByte, subChunkIndex) {
    return HeldStorage.subChunkOf(this.chunkForByte(weaveByte), subChunkIndex);
  }

  /** How many chunks are held, in memory or not. */
  get chunkCount() {
    return this.alignedBuckets.size + this.unalignedEnds.length;
  }

  get byteCount() {
    return this.chunkCount * ConsensusConstants.DATA_CHUNK_SIZE;
  }

  bytesInPartition(partitionNumber) {
    return this.bytesByPartition.get(Number(partitionNumber)) ?? 0;
  }

  /** [[partition number, bytes held]] for every partition holding any. */
  partitionsHeld() {
    return [...this.bytesByPartition];
  }

  /** Held end offsets (BigInt) ending in partition `partitionNumber`, ascending. */
  *heldEndsInPartition(partitionNumber) {
    const partitionStart = BigInt(partitionNumber) * ConsensusConstants.PARTITION_SIZE;
    const partitionEnd = partitionStart + ConsensusConstants.PARTITION_SIZE;
    // An end e lies in the partition when partitionStart < e <= partitionEnd.
    for (const end of this.unalignedEnds) {
      if (end > partitionStart && end <= partitionEnd) yield end;
    }
    const [low, high] = HeldStorage.bucketRangeOfPartition(partitionNumber);
    for (const bucketNumber of this.alignedBuckets.ascending(low, high)) yield HeldStorage.bucketEnd(bucketNumber);
  }

  /** The first held end offset in any order, or null when nothing is held. */
  firstHeldEnd() {
    if (this.unalignedEnds.length) return this.unalignedEnds[0];
    const first = this.alignedBuckets.ascending().next();
    return first.done ? null : HeldStorage.bucketEnd(first.value);
  }
}
