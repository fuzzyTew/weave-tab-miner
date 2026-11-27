// src/network/chunk-filler.js — fills held storage: picks positions in a partition, fetches
// their chunks, packs them for the mining address and holds them, a batch at a time. Shared
// by the page and the node program; each says how to save (or not) and what to show.

import { ConsensusConstants } from '../core/constants.js';
import { ChunkPacker, Replica29Layout } from '../mining/packing.js';
import { ChunkFetcher } from './chunk-fetcher.js';
import { NetworkTarget } from './network-target.js';

export class ChunkFiller {
  /**
   * `gateway` fetches chunks (ArweaveGateway); `network` is the NetworkTarget (a localnet
   * keeps its data at its start); `identity` and `entropySource` pack; `storage` is the
   * HeldStorage chunks are added to. `save(entries)` keeps a packed batch ([[endOffset,
   * packedChunk]]) where it outlasts the session, resolving whether it did; the default
   * keeps nothing.
   *
   * Callbacks: `onProgress(progress, heldSoFar)` as chunks arrive (ChunkFetchProgress);
   * `onSkip(weaveByte, error)` for a chunk no source had; `onPackProgress(done, total)`
   * for entropies; `onBatchHeld({ count, seconds })` after each batch is packed and saved.
   */
  constructor({
    gateway, network = NetworkTarget.MAINNET, identity, entropySource, storage, save = async () => false,
    concurrency = ChunkFiller.CONCURRENCY, batchSize = ChunkFiller.BATCH_SIZE,
    onProgress = () => {}, onSkip = () => {}, onPackProgress = () => {}, onBatchHeld = () => {},
  }) {
    Object.assign(this, { gateway, network, identity, entropySource, storage, save, concurrency, batchSize, onProgress, onSkip, onPackProgress, onBatchHeld });
  }

  /** Requests at once: enough to hide each request's latency, few enough to be polite. */
  static CONCURRENCY = 6;
  /** Chunks packed and saved together (32 MiB), so a long fetch never holds it all in memory. */
  static BATCH_SIZE = 128;

  /**
   * The positions to fetch in a partition: chunks at one bucket position in successive
   * sectors share all 32 entropies, so the run starts at a random bucket of the first
   * sector (`randomFraction` in [0, 1)) and walks sectors before buckets.
   */
  positions(partitionNumber, partitionUpperBound, randomFraction) {
    const partitionStart = BigInt(partitionNumber) * ConsensusConstants.PARTITION_SIZE;
    const firstByte = partitionStart + BigInt(Math.floor(randomFraction * Number(ConsensusConstants.entropySectorSize)));
    return this.network.chunkPositions(partitionStart, Replica29Layout.entropySharingPositions(firstByte, partitionUpperBound), ConsensusConstants.DATA_CHUNK_SIZE);
  }

  /**
   * Fetches, packs and holds up to `wanted` chunks of `partitionNumber`. Each batch is
   * packed while the next is fetched (packing runs in RandomX, so requests keep going);
   * one batch packs at a time. `signal` stops it early: requests in flight finish and what
   * arrived is packed. Resolves { held, aborted, lastProgress }.
   */
  async fill({ partitionNumber, partitionUpperBound, wanted, signal = new AbortController().signal, randomFraction = Math.random() }) {
    const fetcher = new ChunkFetcher({ gateway: this.gateway, concurrency: this.concurrency });
    let held = 0;
    let lastProgress = null;
    const batches = fetcher.batches(this.positions(partitionNumber, partitionUpperBound, randomFraction), {
      wanted, batchSize: this.batchSize, signal,
      onProgress: (progress) => {
        lastProgress = progress;
        this.onProgress(progress, held);
      },
      onSkip: this.onSkip,
    });
    let packing = Promise.resolve();
    for await (const batch of batches) {
      await packing;
      packing = this.packAndHold(batch).then(() => {
        held += batch.length;
        if (lastProgress) this.onProgress(lastProgress, held);
      });
    }
    await packing;
    return { held, aborted: signal.aborted, lastProgress };
  }

  /** Packs fetched chunks ({ bytes, endOffset }) for the identity, holds them and saves them. */
  async packAndHold(chunks) {
    const started = performance.now();
    const packed = await new ChunkPacker(this.identity, this.entropySource).packChunks(chunks, this.onPackProgress);
    const entries = packed.map((packedChunk, index) => [chunks[index].endOffset, packedChunk]);
    for (const [endOffset, packedChunk] of entries) this.storage.add(endOffset, packedChunk);
    if (await this.save(entries)) this.storage.markReloadable(entries.map(([endOffset]) => endOffset));
    this.onBatchHeld({ count: chunks.length, seconds: (performance.now() - started) / 1000 });
  }
}
