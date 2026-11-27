// src/mining/held-storage.js — The packed chunks a node holds, kept on disk and read in as steps need them.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { ConsensusConstants } from '../core/constants.js';
import { Replica29Layout } from './packing.js';

export class HeldStorage {
  /**
   * The packed chunks this node holds, keyed by end offset (Replica29Layout.storedEndOffset:
   * the bucket's end above the strict data split threshold, the chunk's own end below it,
   * where chunks do not fill whole buckets), each one 256 KiB buffer of 32 packed sub-chunks. A real node keeps terabytes on disk; a tab keeps what its
   * browser storage allows (see src/storage/chunk-store.js).
   *
   * Every held chunk is known by its offset, but only some need to be in memory. Given
   * `loadChunk(bucketEndOffset) → Promise<Uint8Array|null>`, chunks marked reloadable (saved
   * somewhere loadChunk can read) are dropped from memory beyond `residentLimit`, least
   * recently used first, and read back when a step needs them (ensureLoaded). Without a
   * loader everything stays in memory.
   */
  constructor({ loadChunk = null, residentLimit = 64 } = {}) {
    this.packedChunks = new Map(); // offset string -> Uint8Array, or null when only on disk
    this.reloadable = new Set();
    this.loadChunk = loadChunk;
    this.residentLimit = residentLimit;
    this.resident = new Set(); // offsets in memory, least recently used first
    this.unalignedEnds = []; // held end offsets below the threshold, ascending (BigInt)
    // Kept as chunks arrive, so counts cost O(1) however much is held (millions of chunks
    // for a full partition), rather than a walk over every key.
    this.bytesByPartition = new Map(); // partition number -> bytes held in it
    this.changeCount = 0; // grows whenever a chunk is added; caches compare it
  }

  /** Counts a key not held before (call before setting it in packedChunks). */
  countNewKey(key) {
    if (this.packedChunks.has(key)) return;
    const partitionNumber = Number((BigInt(key) - 1n) / ConsensusConstants.PARTITION_SIZE);
    this.bytesByPartition.set(partitionNumber, (this.bytesByPartition.get(partitionNumber) ?? 0) + ConsensusConstants.DATA_CHUNK_SIZE);
    this.changeCount++;
  }

  /** Notes an end offset below the threshold, where finding a byte's chunk needs a search. */
  noteEnd(key) {
    const end = BigInt(key);
    if (end > ConsensusConstants.STRICT_DATA_SPLIT_THRESHOLD || this.packedChunks.has(key)) return;
    const index = this.firstEndAfter(end - 1n);
    this.unalignedEnds.splice(index, 0, end);
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
   * The key of the held chunk holding `weaveByte`: its bucket's end above the threshold;
   * below it, the first held end past the byte, if within a chunk's size (chunks there
   * are contiguous, so that one holds the byte).
   */
  keyForByte(weaveByte) {
    if (weaveByte >= ConsensusConstants.STRICT_DATA_SPLIT_THRESHOLD) return Replica29Layout.bucketEndOffsetForByte(weaveByte).toString();
    const end = this.unalignedEnds[this.firstEndAfter(weaveByte)];
    if (end !== undefined && end - weaveByte <= BigInt(ConsensusConstants.DATA_CHUNK_SIZE)) return end.toString();
    return null;
  }

  add(endOffset, packedChunk, { reloadable = false } = {}) {
    const key = endOffset.toString();
    this.noteEnd(key);
    this.countNewKey(key);
    this.packedChunks.set(key, packedChunk);
    if (reloadable) this.reloadable.add(key);
    this.touch(key);
  }

  /** A chunk saved where loadChunk can read it, known by offset only until needed. */
  addOnDisk(endOffset) {
    const key = endOffset.toString();
    if (this.packedChunks.get(key)) return;
    this.noteEnd(key);
    this.countNewKey(key);
    this.packedChunks.set(key, null);
    this.reloadable.add(key);
  }

  /** Marks chunks as saved, so they may leave memory. */
  markReloadable(bucketEndOffsets) {
    for (const offset of bucketEndOffsets) this.reloadable.add(offset.toString());
    this.evictBeyondLimit();
  }

  touch(key) {
    this.resident.delete(key);
    this.resident.add(key);
    this.evictBeyondLimit();
  }

  evictBeyondLimit() {
    if (!this.loadChunk) return;
    for (const key of this.resident) {
      if (this.resident.size <= this.residentLimit) break;
      if (!this.reloadable.has(key)) continue;
      this.packedChunks.set(key, null);
      this.resident.delete(key);
    }
  }

  /**
   * Brings the chunks holding these weave bytes into memory, where held, reading those on
   * disk in parallel. Resolves the number read from disk. Callers should ask for no more
   * than `residentLimit` chunks at once, or the first may leave memory again before use.
   */
  async ensureLoaded(weaveBytes) {
    const keys = [...new Set(weaveBytes.map((byte) => this.keyForByte(byte)))]
      .filter((key) => key !== null && this.packedChunks.has(key));
    const onDisk = keys.filter((key) => this.packedChunks.get(key) === null && this.loadChunk);
    const read = await Promise.all(onDisk.map((key) => this.loadChunk(BigInt(key))));
    onDisk.forEach((key, index) => {
      if (read[index]) this.packedChunks.set(key, read[index]);
    });
    for (const key of keys) {
      if (this.packedChunks.get(key)) this.touch(key);
    }
    return read.filter(Boolean).length;
  }

  get residentCount() {
    return this.resident.size;
  }

  /** The packed chunk holding `weaveByte`, if held and in memory; else null. */
  chunkForByte(weaveByte) {
    const key = this.keyForByte(weaveByte);
    return key === null ? null : this.packedChunks.get(key) ?? null;
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

  get byteCount() {
    return this.packedChunks.size * ConsensusConstants.DATA_CHUNK_SIZE;
  }

  bytesInPartition(partitionNumber) {
    return this.bytesByPartition.get(Number(partitionNumber)) ?? 0;
  }
}
