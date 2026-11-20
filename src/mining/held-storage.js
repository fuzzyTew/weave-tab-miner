// src/mining/held-storage.js — The packed chunks a node holds, kept on disk and read in as steps need them.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { ConsensusConstants } from '../core/constants.js';
import { Replica29Layout } from './packing.js';

export class HeldStorage {
  /**
   * The packed chunks this node holds, keyed by bucket end offset, each one 256 KiB buffer
   * of 32 packed sub-chunks. A real node keeps terabytes on disk; a tab keeps what its
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
  }

  add(bucketEndOffset, packedChunk, { reloadable = false } = {}) {
    const key = bucketEndOffset.toString();
    this.packedChunks.set(key, packedChunk);
    if (reloadable) this.reloadable.add(key);
    this.touch(key);
  }

  /** A chunk saved where loadChunk can read it, known by offset only until needed. */
  addOnDisk(bucketEndOffset) {
    const key = bucketEndOffset.toString();
    if (this.packedChunks.get(key)) return;
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
    const keys = [...new Set(weaveBytes.map((byte) => Replica29Layout.bucketEndOffsetForByte(byte).toString()))]
      .filter((key) => this.packedChunks.has(key));
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
    return this.packedChunks.get(Replica29Layout.bucketEndOffsetForByte(weaveByte).toString()) ?? null;
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
    const partitionSize = ConsensusConstants.PARTITION_SIZE;
    let count = 0;
    for (const key of this.packedChunks.keys()) {
      if ((BigInt(key) - 1n) / partitionSize === BigInt(partitionNumber)) count += ConsensusConstants.DATA_CHUNK_SIZE;
    }
    return count;
  }
}
