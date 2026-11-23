// src/network/chunk-fetcher.js — fetches many chunks from gateways or nodes a few at a time, with
// progress, a stop, and batches handed back as they fill so they can be packed and saved
// without holding everything in memory.
import { Bytes } from '../core/bytes.js';
import { Replica29Layout } from '../mining/packing.js';

export class ChunkFetchProgress {
  /**
   * A running tally: chunks fetched and skipped, bytes, and the speed so far, from which
   * the time left is estimated (assuming the speed stays as it has been).
   */
  constructor(wanted) {
    Object.assign(this, { wanted, fetched: 0, skipped: 0, bytes: 0, startedAt: performance.now() });
  }

  get seconds() {
    return (performance.now() - this.startedAt) / 1000;
  }

  get bytesPerSecond() {
    return this.seconds > 0 ? this.bytes / this.seconds : 0;
  }

  get secondsLeft() {
    const chunksPerSecond = this.fetched / Math.max(this.seconds, 1e-3);
    return chunksPerSecond > 0 ? (this.wanted - this.fetched) / chunksPerSecond : Infinity;
  }
}

export class ChunkFetcher {
  /**
   * `concurrency` requests run at once; each asks a few sources in turn
   * (ArweaveGateway.chunkJson). A chunk no source has is skipped and the next position
   * taken in its place, so `wanted` chunks arrive if enough positions exist.
   */
  constructor({ gateway, concurrency = 6 }) {
    Object.assign(this, { gateway, concurrency });
  }

  /**
   * Yields batches of { bytes, endOffset } as each fills to `batchSize`, then the rest.
   * `positions` is an iterator of weave bytes (e.g. Replica29Layout.entropySharingPositions).
   * Stopping through `signal` lets requests in flight finish but starts no more.
   */
  async *batches(positions, { wanted, batchSize = 256, signal = null, onProgress = () => {}, onSkip = () => {} }) {
    const progress = new ChunkFetchProgress(wanted);
    const ready = [];
    let positionsLeft = true;
    let inFlight = 0;
    let wake = null;
    const notify = () => { if (wake) { wake(); wake = null; } };

    const startOne = () => {
      const next = positions.next();
      if (next.done) { positionsLeft = false; return; }
      const weaveByte = next.value;
      inFlight++;
      this.gateway.chunkJson(weaveByte).then((reply) => {
        const bytes = Bytes.fromBase64Url(reply.chunk);
        // Filed under the 256 KiB bucket holding the byte asked for, which is the chunk's
        // own bucket above the strict data split threshold, where held partitions lie
        // (Replica29Layout.firstBucketAlignedPartition).
        ready.push({ bytes, endOffset: Replica29Layout.bucketEndOffsetForByte(weaveByte) });
        progress.fetched++;
        progress.bytes += bytes.length;
      }, (error) => {
        progress.skipped++;
        onSkip(weaveByte, error);
      }).finally(() => {
        inFlight--;
        onProgress(progress);
        notify();
      });
    };

    for (;;) {
      const stopped = signal?.aborted || progress.fetched + inFlight >= wanted;
      while (!stopped && positionsLeft && inFlight < this.concurrency && progress.fetched + inFlight < wanted) startOne();
      if (ready.length >= batchSize) { yield ready.splice(0, batchSize); continue; }
      if (inFlight === 0 && (signal?.aborted || !positionsLeft || progress.fetched >= wanted)) break;
      await new Promise((resolve) => { wake = resolve; });
    }
    if (ready.length) yield ready.splice(0);
  }
}
