// src/mining/packing.js — Replica 2.9 packing: where chunks and entropies sit, and XOR-packing chunks.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { Bytes } from '../core/bytes.js';
import { ConsensusConstants } from '../core/constants.js';
import { Sha256 } from '../core/sha256.js';

export class Replica29Layout {
  /**
   * Where each stored sub-chunk's mask comes from (src/ar_replica_2_9.erl). The data is
   * cut into 256 KiB buckets; a partition is cut into 1024 sectors of ~3.5 GB. Within a
   * sector every chunk gets distinct entropies; the sector number picks which 8 KiB
   * slice of each 8 MiB entropy a chunk uses.
   */
  static paddedEndOffset(absoluteEndOffset) {
    const threshold = ConsensusConstants.STRICT_DATA_SPLIT_THRESHOLD;
    if (absoluteEndOffset <= threshold) return absoluteEndOffset;
    const chunkSize = BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
    return threshold + ((absoluteEndOffset - threshold - 1n) / chunkSize + 1n) * chunkSize;
  }

  static bucketStart(absoluteEndOffset) {
    const chunkSize = BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
    let pickOffset = Replica29Layout.paddedEndOffset(absoluteEndOffset) - chunkSize;
    if (pickOffset < 0n) pickOffset = 0n;
    return pickOffset - (pickOffset % chunkSize);
  }

  static entropyPartition(absoluteEndOffset) {
    return Replica29Layout.bucketStart(absoluteEndOffset) / ConsensusConstants.PARTITION_SIZE;
  }

  static partitionOffset(absoluteEndOffset) {
    return Replica29Layout.bucketStart(absoluteEndOffset)
      - Replica29Layout.entropyPartition(absoluteEndOffset) * ConsensusConstants.PARTITION_SIZE;
  }

  static entropyIndex(absoluteEndOffset, subChunkStartOffset) {
    const chunkBucket = (Replica29Layout.partitionOffset(absoluteEndOffset) % ConsensusConstants.entropySectorSize)
      / BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
    return chunkBucket * BigInt(ConsensusConstants.SUB_CHUNK_COUNT) + BigInt(subChunkStartOffset / ConsensusConstants.SUB_CHUNK_SIZE);
  }

  static sliceIndex(absoluteEndOffset) {
    return Number((Replica29Layout.partitionOffset(absoluteEndOffset) / ConsensusConstants.entropySectorSize)
      % BigInt(ConsensusConstants.subChunksPerEntropy));
  }

  /** ar_replica_2_9:get_entropy_key/3 — the seed of one 8 MiB entropy. */
  static entropyKey(addressBytes, absoluteEndOffset, subChunkStartOffset) {
    return Sha256.hash(
      Bytes.fromBigInt(Replica29Layout.entropyPartition(absoluteEndOffset), 32),
      Bytes.fromBigInt(Replica29Layout.entropyIndex(absoluteEndOffset, subChunkStartOffset), 32),
      addressBytes,
    );
  }

  /**
   * Weave bytes, one per sector, whose chunks all sit at the same bucket position as the
   * chunk holding `firstByte`. Such chunks share all 32 of their entropies, so packing
   * `count` of them costs the same 32 entropies as packing one (up to 1024 per partition).
   */
  static entropySharingBytes(firstByte, count, weaveUpperBound) {
    const bytes = [];
    for (const byte of Replica29Layout.entropySharingPositions(firstByte, weaveUpperBound)) {
      if (bytes.length >= count) break;
      bytes.push(byte);
    }
    return bytes;
  }

  /**
   * Every position in `firstByte`'s partition, ordered so that each run of up to 1,024
   * shares one set of entropies: the same bucket in each sector, then the next bucket.
   * Packing in this order needs 32 entropies per run instead of 32 per chunk.
   */
  static *entropySharingPositions(firstByte, weaveUpperBound) {
    const sectorSize = ConsensusConstants.entropySectorSize;
    const chunkSize = BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
    const partitionStart = (firstByte / ConsensusConstants.PARTITION_SIZE) * ConsensusConstants.PARTITION_SIZE;
    const partitionEnd = partitionStart + ConsensusConstants.PARTITION_SIZE;
    const limit = partitionEnd < weaveUpperBound ? partitionEnd : weaveUpperBound;
    const firstOffsetInSector = (firstByte - partitionStart) % sectorSize;
    for (let bucketOffset = firstOffsetInSector; bucketOffset < sectorSize; bucketOffset += chunkSize) {
      for (let byte = partitionStart + bucketOffset; byte < limit; byte += sectorSize) yield byte;
    }
  }

  /** The end offset of the 256 KiB bucket holding `weaveByte` (above the split threshold). */
  static bucketEndOffsetForByte(weaveByte) {
    const chunkSize = BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
    const threshold = ConsensusConstants.STRICT_DATA_SPLIT_THRESHOLD;
    if (weaveByte < threshold) return weaveByte + 1n; // Approximation: older data is not bucket-aligned.
    return threshold + ((weaveByte - threshold) / chunkSize + 1n) * chunkSize;
  }
}

export class StubEntropySource {
  /**
   * STUB — not consensus-compatible; for browsers that cannot allocate the 512 MiB RandomX
   * cache. Real entropy is RandomxSquaredEntropySource (src/mining/randomx.js). This stand-in
   * fills the 8 MiB entropy from an xorshift128 generator (a fast non-cryptographic
   * pseudo-random sequence) seeded with SHA-256 of the key: quick, deterministic, and
   * worthless for real mining. Same interface: entropyKey -> Promise<8 MiB entropy>.
   */
  isStub = true;

  async entropy(entropyKey) {
    const seed = new Uint32Array(Sha256.hash(entropyKey).buffer, 0, 4);
    let [x, y, z, w] = seed.length === 4 && seed.some(Boolean) ? seed : [1, 2, 3, 4];
    const words = new Uint32Array(ConsensusConstants.REPLICA_2_9_ENTROPY_SIZE / 4);
    for (let index = 0; index < words.length; index++) {
      const t = x ^ (x << 11);
      x = y; y = z; z = w;
      w = (w ^ (w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
      words[index] = w;
    }
    return new Uint8Array(words.buffer);
  }
}

export class ChunkPacker {
  /**
   * Replica 2.9 packing (src/ar_packing_server.erl exor_replica_2_9_chunk): each 8 KiB
   * sub-chunk is XORed with its slice of its own 8 MiB entropy. XOR again to unpack.
   *
   * One entropy serves the same sub-chunk position of the chunk at the same bucket in every
   * one of a partition's 1024 sectors (ar_replica_2_9.erl), so packing a batch groups the
   * chunks by entropy key and computes each entropy once.
   */
  constructor(identity, entropySource) {
    this.identity = identity;
    this.entropySource = entropySource;
  }

  static padChunk(chunkBytes) {
    if (chunkBytes.length === ConsensusConstants.DATA_CHUNK_SIZE) return chunkBytes.slice();
    const padded = new Uint8Array(ConsensusConstants.DATA_CHUNK_SIZE);
    padded.set(chunkBytes.subarray(0, ConsensusConstants.DATA_CHUNK_SIZE));
    return padded;
  }

  /**
   * Pack chunks given as [{ bytes, endOffset }]. Returns one 256 KiB packed buffer per
   * chunk, in order. `onEntropy(done, total)` reports progress per entropy computed.
   */
  async packChunks(chunks, onEntropy = () => {}) {
    const subChunkSize = ConsensusConstants.SUB_CHUNK_SIZE;
    const packed = chunks.map(({ bytes }) => ChunkPacker.padChunk(bytes));

    const jobsByKey = new Map(); // entropy key hex -> { key, uses: [[chunkIndex, subChunkIndex]] }
    chunks.forEach(({ endOffset }, chunkIndex) => {
      for (let subChunkIndex = 0; subChunkIndex < ConsensusConstants.SUB_CHUNK_COUNT; subChunkIndex++) {
        const key = Replica29Layout.entropyKey(this.identity.addressBytes, endOffset, subChunkIndex * subChunkSize);
        const keyHex = Bytes.toHex(key);
        if (!jobsByKey.has(keyHex)) jobsByKey.set(keyHex, { key, uses: [] });
        jobsByKey.get(keyHex).uses.push([chunkIndex, subChunkIndex]);
      }
    });

    let done = 0;
    for (const { key, uses } of jobsByKey.values()) {
      const entropy = await this.entropySource.entropy(key);
      for (const [chunkIndex, subChunkIndex] of uses) {
        const sliceStart = Replica29Layout.sliceIndex(chunks[chunkIndex].endOffset) * subChunkSize;
        const target = packed[chunkIndex].subarray(subChunkIndex * subChunkSize, (subChunkIndex + 1) * subChunkSize);
        for (let index = 0; index < subChunkSize; index++) target[index] ^= entropy[sliceStart + index];
      }
      onEntropy(++done, jobsByKey.size);
    }
    return packed;
  }

  /**
   * Packed data for one address turned into packed data for another, without the original
   * bytes: packing is an XOR with entropy, so packing again for the old address restores
   * the plain chunk, which is then packed for the new one. `entries` is
   * [[bucketEndOffset, Uint8Array(256 KiB)], ...]; returns the same shape. Costs the
   * entropies of both addresses; chunks at one bucket position share them, so a set
   * fetched together repacks in about a minute.
   */
  static async repackChunks({ entries, fromIdentity, toIdentity, entropySource, onEntropy = () => {} }) {
    const asChunks = (list) => list.map(([endOffset, bytes]) => ({ endOffset, bytes }));
    const plain = await new ChunkPacker(fromIdentity, entropySource).packChunks(asChunks(entries), (done, total) => onEntropy(done, total * 2));
    const offsets = entries.map(([endOffset]) => endOffset);
    const repacked = await new ChunkPacker(toIdentity, entropySource).packChunks(plain.map((bytes, index) => ({ endOffset: offsets[index], bytes })), (done, total) => onEntropy(total + done, total * 2));
    return repacked.map((bytes, index) => [offsets[index], bytes]);
  }

  async packChunk(chunkBytes, endOffset) {
    return (await this.packChunks([{ bytes: chunkBytes, endOffset }]))[0];
  }
}
