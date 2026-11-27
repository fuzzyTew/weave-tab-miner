// src/mining/storage-sizing.js — what holding more costs a browser miner as storage grows:
// reads per step, memory, startup, fill time, the disk needed, and where returns stop.
// Pure arithmetic from measured rates, so a page, a node app or a port can share it.

import { ConsensusConstants } from '../core/constants.js';
import { PrettyNumber } from '../core/pretty-number.js';

export class StorageSizing {
  /**
   * Costs of holding `heldBytes` in one partition, for a miner like this app's: one
   * partition per mining address, chunks kept one per record (in Chrome, one file each),
   * every held offset indexed in memory.
   *
   * The defaults are measured (scripts/storage-bench.mjs in headless Chrome on a cloud
   * SSD, file cache dropped; test/storage-sizing.test.mjs times the index); a page passes
   * its own measured rates instead where it has them, since disks differ by 10× and more
   * (a USB hard drive spends roughly 10 ms per chunk moving its head; flash, about 1 ms).
   */
  static MEASURED = {
    readMsPerChunk: 1.5, // cold read of one 256 KiB chunk through IndexedDB
    indexBytesPerChunk: 82, // HeldStorage's offset text in a Map and a Set
    startupMicrosecondsPerChunk: 22, // the key scan at startup plus indexing each key
    fillBytesPerSecond: null, // fetch and pack: depends on the network and CPU; unknown until measured
  };

  /**
   * Where a browser's own limits bind. Chrome lets a site use about 60% of the disk
   * holding the profile; Firefox, up to half the free disk once storage is kept
   * (persisted). This app leaves the last tenth of that unused (StorageAllowance).
   */
  static CHROME_DISK_SHARE = 0.6;
  static USABLE_SHARE = 0.9;
  /** A tab's memory past which the browser may stop it; Chrome's per-tab heap is about 4 GiB. */
  static TAB_MEMORY_COMFORT_BYTES = 1 * 2 ** 30;
  /** A startup longer than this keeps a person waiting on each visit. */
  static STARTUP_COMFORT_SECONDS = 60;
  /** Reading may take this share of a step before it slows mining below the network's pace. */
  static READ_SHARE_COMFORT = 0.5;

  constructor({ heldBytes, weaveBytes, measured = {}, stepSeconds = 1 }) {
    this.heldBytes = heldBytes;
    this.weaveBytes = weaveBytes;
    this.measured = { ...StorageSizing.MEASURED, ...Object.fromEntries(Object.entries(measured).filter(([, value]) => value != null)) };
    this.stepSeconds = stepSeconds;
  }

  static get partitionBytes() {
    return Number(ConsensusConstants.PARTITION_SIZE);
  }

  get chunkCount() {
    return Math.ceil(this.heldBytes / ConsensusConstants.DATA_CHUNK_SIZE);
  }

  /** The share of its one partition held: the storage factor of the wait is its inverse. */
  get partitionFraction() {
    return Math.min(1, this.heldBytes / StorageSizing.partitionBytes);
  }

  /**
   * Chunks read per step, on average: range 1's chunks that are held, plus range 2's
   * (range 2 lands anywhere in the weave, so it is held at the weave fraction).
   */
  get chunksReadPerStep() {
    const chunksPerRange = ConsensusConstants.recallRangeSize / ConsensusConstants.DATA_CHUNK_SIZE;
    return chunksPerRange * (this.partitionFraction + Math.min(1, this.heldBytes / this.weaveBytes));
  }

  get readBytesPerSecond() {
    return this.chunksReadPerStep * ConsensusConstants.DATA_CHUNK_SIZE / this.stepSeconds;
  }

  /** Reading time per step, counting reads one after another (the miner overlaps a pair). */
  get readMsPerStep() {
    return this.chunksReadPerStep * this.measured.readMsPerChunk;
  }

  get readShareOfStep() {
    return this.readMsPerStep / (this.stepSeconds * 1000);
  }

  get indexMemoryBytes() {
    return this.chunkCount * this.measured.indexBytesPerChunk;
  }

  get startupSeconds() {
    return this.chunkCount * this.measured.startupMicrosecondsPerChunk / 1e6;
  }

  /** Seconds to fetch and pack this much at the measured rate, or null before it is measured. */
  get fillSeconds() {
    return this.measured.fillBytesPerSecond ? this.heldBytes / this.measured.fillBytesPerSecond : null;
  }

  /** The disk a Chrome profile needs for the site to be allowed this much. */
  get chromeDiskBytes() {
    return this.heldBytes / StorageSizing.USABLE_SHARE / StorageSizing.CHROME_DISK_SHARE;
  }

  /**
   * The held size at which each limit binds, smallest first: [{ name, bytes, explanation }].
   * Past the partition, held data adds nothing to range 1 (one partition per address here);
   * the others are soft: past them the tab still works, with the cost named.
   */
  limits() {
    const chunk = ConsensusConstants.DATA_CHUNK_SIZE;
    const { readMsPerChunk, indexBytesPerChunk, startupMicrosecondsPerChunk } = this.measured;
    const chunksPerRange = ConsensusConstants.recallRangeSize / chunk;
    const partition = StorageSizing.partitionBytes;
    // Reads per step grow with the partition fraction (range 1) and weave fraction (range 2).
    const readShareAt = (bytes) => chunksPerRange * (Math.min(1, bytes / partition) + Math.min(1, bytes / this.weaveBytes)) * readMsPerChunk / (this.stepSeconds * 1000);
    const readLimitBytes = readShareAt(partition) <= StorageSizing.READ_SHARE_COMFORT ? Infinity
      : StorageSizing.READ_SHARE_COMFORT * this.stepSeconds * 1000 / (chunksPerRange * readMsPerChunk * (1 / partition + 1 / this.weaveBytes));
    return [
      { name: 'partition', bytes: partition, explanation: 'one partition per address: more held data there is impossible, and data elsewhere only helps two-chunk tries' },
      { name: 'memory', bytes: StorageSizing.TAB_MEMORY_COMFORT_BYTES / indexBytesPerChunk * chunk, explanation: `the in-memory index of held chunks passes ${PrettyNumber.bytes(StorageSizing.TAB_MEMORY_COMFORT_BYTES)}` },
      { name: 'startup', bytes: StorageSizing.STARTUP_COMFORT_SECONDS * 1e6 / startupMicrosecondsPerChunk * chunk, explanation: `listing held chunks at each start takes over ${StorageSizing.STARTUP_COMFORT_SECONDS} s` },
      { name: 'reads', bytes: readLimitBytes, explanation: `reading takes over half of each step on this disk (${readMsPerChunk.toFixed(1)} ms a chunk), so mining falls behind the network` },
    ].sort((left, right) => left.bytes - right.bytes);
  }
}
