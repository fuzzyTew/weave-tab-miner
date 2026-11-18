// src/miner.js — a library for an in-browser Arweave mining node (replica 2.9 format).
// Each class mirrors a piece of the Erlang node source (commit 18d402c); the matching
// source location is named in its docstring so every rule can be checked against it.
// Two pieces are stand-ins (class names start with Stub) because they need Arweave's
// RandomX fork compiled to WebAssembly; they share an interface with the real thing.

export class ConsensusConstants {
  /**
   * Consensus values from apps/arweave/include/{ar.hrl, ar_consensus.hrl, ar_vdf.hrl}.
   */
  static DATA_CHUNK_SIZE = 262144;
  static SUB_CHUNK_COUNT = 32;
  static SUB_CHUNK_SIZE = 8192;
  static PARTITION_SIZE = 3_600_000_000_000n;
  static RECALL_RANGE_SIZE = 26_214_400;
  static REPLICA_2_9_PACKING_DIFFICULTY = 10;
  static REPLICA_2_9_ENTROPY_SIZE = 8_388_608;
  static REPLICA_2_9_ENTROPY_COUNT = 429_184n;
  static STRICT_DATA_SPLIT_THRESHOLD = 30_607_159_107_830n;
  static POA1_DIFF_MULTIPLIER = 100n;
  static MAX_DIFF = 1n << 256n;
  static VDF_CHECKPOINT_COUNT_IN_STEP = 25;
  static NONCE_LIMITER_RESET_FREQUENCY = 1200;

  static get recallRangeSize() {
    return this.RECALL_RANGE_SIZE / this.REPLICA_2_9_PACKING_DIFFICULTY;
  }
  static get noncesPerRecallRange() {
    return this.recallRangeSize / this.SUB_CHUNK_SIZE;
  }
  static get entropySectorSize() {
    return this.REPLICA_2_9_ENTROPY_COUNT * BigInt(this.SUB_CHUNK_SIZE);
  }
  static get subChunksPerEntropy() {
    return this.REPLICA_2_9_ENTROPY_SIZE / this.SUB_CHUNK_SIZE;
  }
}

export class Bytes {
  /**
   * Byte-array helpers. Arweave's JSON uses base64url without padding; big integers
   * are big-endian ("network order"), as in Erlang's <<N:256>>.
   */
  static fromBase64Url(text) {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  static toBase64Url(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  static toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  static concat(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let position = 0;
    for (const part of parts) {
      joined.set(part, position);
      position += part.length;
    }
    return joined;
  }

  static fromBigInt(value, byteCount) {
    const bytes = new Uint8Array(byteCount);
    for (let index = byteCount - 1; index >= 0; index--) {
      bytes[index] = Number(value & 0xffn);
      value >>= 8n;
    }
    return bytes;
  }

  static toBigInt(bytes) {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
  }

  static equal(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
    return true;
  }
}

export class Sha256 {
  /**
   * Synchronous SHA-256 in plain JavaScript. WebCrypto only offers an asynchronous
   * digest, which is far too slow for the VDF's millions of chained hashes, so this
   * class computes it directly. digest64() is a fast path for exactly 64-byte inputs:
   * their padding block is the same every time, so its message schedule (the 64
   * expanded words SHA-256 derives from each block) is computed once and reused.
   */
  static ROUND_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  static INITIAL_STATE = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  constructor() {
    this.schedule = new Uint32Array(64);
    this.state = new Uint32Array(8);
    this.paddingSchedule64 = Sha256.expandedPaddingScheduleForLength(64);
  }

  static expandedPaddingScheduleForLength(messageByteLength) {
    // The final block for a message that exactly fills whole blocks: a 1 bit, zeros,
    // then the message length in bits.
    const schedule = new Uint32Array(64);
    schedule[0] = 0x80000000;
    schedule[15] = messageByteLength * 8;
    Sha256.expandSchedule(schedule);
    return schedule;
  }

  static expandSchedule(schedule) {
    for (let index = 16; index < 64; index++) {
      const word15 = schedule[index - 15];
      const word2 = schedule[index - 2];
      const sigma0 = ((word15 >>> 7) | (word15 << 25)) ^ ((word15 >>> 18) | (word15 << 14)) ^ (word15 >>> 3);
      const sigma1 = ((word2 >>> 17) | (word2 << 15)) ^ ((word2 >>> 19) | (word2 << 13)) ^ (word2 >>> 10);
      schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) | 0;
    }
  }

  static compress(state, schedule) {
    const constants = Sha256.ROUND_CONSTANTS;
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let round = 0; round < 64; round++) {
      const sum1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + constants[round] + schedule[round]) | 0;
      const sum0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
    state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0;
    state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
  }

  loadBlockWords(bytes, offset) {
    for (let word = 0; word < 16; word++) {
      const at = offset + word * 4;
      this.schedule[word] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    }
    Sha256.expandSchedule(this.schedule);
  }

  writeState(output, outputOffset = 0) {
    for (let word = 0; word < 8; word++) {
      const value = this.state[word];
      output[outputOffset + word * 4] = value >>> 24;
      output[outputOffset + word * 4 + 1] = (value >>> 16) & 0xff;
      output[outputOffset + word * 4 + 2] = (value >>> 8) & 0xff;
      output[outputOffset + word * 4 + 3] = value & 0xff;
    }
  }

  /** Hash exactly 64 input bytes into output (32 bytes); output may alias input. */
  digest64(input, output) {
    this.state.set(Sha256.INITIAL_STATE);
    this.loadBlockWords(input, 0);
    Sha256.compress(this.state, this.schedule);
    Sha256.compress(this.state, this.paddingSchedule64);
    this.writeState(output);
    return output;
  }

  /** Hash any byte array; returns a new 32-byte array. */
  digest(input) {
    const bitLength = BigInt(input.length) * 8n;
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(input);
    padded[input.length] = 0x80;
    padded.set(Bytes.fromBigInt(bitLength, 8), paddedLength - 8);
    this.state.set(Sha256.INITIAL_STATE);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      this.loadBlockWords(padded, offset);
      Sha256.compress(this.state, this.schedule);
    }
    const output = new Uint8Array(32);
    this.writeState(output);
    return output;
  }

  static hash(...parts) {
    return Sha256.shared.digest(Bytes.concat(...parts));
  }
}
Sha256.shared = new Sha256();

export class VdfChain {
  /**
   * Arweave's verifiable delay function: a chain of salted SHA-256 hashes
   * (c_src/vdf/vdf.cpp _vdf_sha2; src/ar_vdf.erl). A "step" is 25 checkpoints; each
   * checkpoint hashes (salt ‖ previous) `iterationsPerCheckpoint` times with one salt,
   * and the salt — a 256-bit big-endian counter — rises by one per checkpoint.
   * A step's output is its last checkpoint.
   */
  constructor({ iterationsPerCheckpoint }) {
    this.iterationsPerCheckpoint = iterationsPerCheckpoint;
    this.hasher = new Sha256();
    this.buffer = new Uint8Array(64);
  }

  /** ar_vdf:step_number_to_salt_number/1. */
  static saltNumberForStep(stepNumber) {
    return stepNumber === 0 ? 0n : BigInt(stepNumber - 1) * BigInt(ConsensusConstants.VDF_CHECKPOINT_COUNT_IN_STEP) + 1n;
  }

  /** ar_nonce_limiter:mix_seed/2 — entropy injected every NONCE_LIMITER_RESET_FREQUENCY steps. */
  static mixSeed(previousOutput, seed) {
    return Sha256.hash(previousOutput, Sha256.hash(seed));
  }

  static isResetStep(stepNumber) {
    return stepNumber % ConsensusConstants.NONCE_LIMITER_RESET_FREQUENCY === 0;
  }

  computeCheckpoint(saltNumber, input) {
    this.buffer.set(Bytes.fromBigInt(saltNumber, 32), 0);
    this.buffer.set(input, 32);
    for (let iteration = 0; iteration < this.iterationsPerCheckpoint; iteration++) {
      // The digest overwrites the second half of the buffer, ready for the next round.
      this.hasher.digest64(this.buffer, this.buffer.subarray(32));
    }
    return this.buffer.slice(32);
  }

  /**
   * Compute step `stepNumber` from the previous step's output. Returns all 25
   * checkpoints; the last is the step output. `resetSeed` is mixed in on reset steps.
   */
  computeStep(stepNumber, previousOutput, resetSeed = null) {
    let input = previousOutput;
    if (VdfChain.isResetStep(stepNumber) && resetSeed) input = VdfChain.mixSeed(previousOutput, resetSeed);

    // ar_vdf:compute/3 starts at the salt for step (stepNumber - 1); verified against
    // a mainnet block in test/against-block.test.mjs.
    let saltNumber = VdfChain.saltNumberForStep(stepNumber - 1);
    const checkpoints = [];
    for (let index = 0; index < ConsensusConstants.VDF_CHECKPOINT_COUNT_IN_STEP; index++) {
      input = this.computeCheckpoint(saltNumber, input);
      checkpoints.push(input);
      saltNumber += 1n;
    }
    return checkpoints;
  }
}

export class Difficulty {
  /**
   * Solution checks (src/ar_node_utils.erl passes_diff_check, scaled_diff;
   * src/ar_difficulty.erl sub_diff, scale_diff, poa1_diff). A hash passes when, read
   * as a big-endian integer, it is greater than the scaled difficulty.
   */
  static subDiff(diff, count) {
    const maxDiff = ConsensusConstants.MAX_DIFF;
    const reverseDiff = maxDiff - diff;
    const dividend = 2n * count * reverseDiff * maxDiff + (count - 1n) * reverseDiff * reverseDiff;
    const divisor = 2n * count * count * maxDiff * maxDiff;
    return (maxDiff * divisor - dividend * maxDiff) / divisor;
  }

  static scaleDiff(diff, scaleDividend, scaleDivisor) {
    const maxDiff = ConsensusConstants.MAX_DIFF;
    const diffInverse = ((maxDiff - diff) * scaleDivisor) / scaleDividend;
    // Approximation: the node clamps below at min_difficulty(height), a fork-era floor
    // that is far under today's difficulty. Exact would read SPORA_MIN_DIFFICULTY.
    const scaled = maxDiff - diffInverse;
    return scaled < 1n ? 1n : scaled > maxDiff - 1n ? maxDiff - 1n : scaled;
  }

  /** Threshold for one sub-chunk nonce: split across 32 sub-chunks, then eased by 1/(4 × packing difficulty). */
  static scaledForPackingDifficulty(rawDiff, packingDifficulty) {
    const subDiff = Difficulty.subDiff(rawDiff, BigInt(ConsensusConstants.SUB_CHUNK_COUNT));
    return Difficulty.scaleDiff(subDiff, 1n, BigInt(packingDifficulty) * 4n);
  }

  /** One-chunk (PoA1) solutions must beat a difficulty 100 times harder. */
  static poa1(rawDiff) {
    return Difficulty.scaleDiff(rawDiff, ConsensusConstants.POA1_DIFF_MULTIPLIER, 1n);
  }

  static passes(solutionHash, isOneChunkSolution, rawDiff, packingDifficulty = ConsensusConstants.REPLICA_2_9_PACKING_DIFFICULTY) {
    const blockDiff = isOneChunkSolution ? Difficulty.poa1(rawDiff) : rawDiff;
    return Bytes.toBigInt(solutionHash) > Difficulty.scaledForPackingDifficulty(blockDiff, packingDifficulty);
  }

  /** Chance that one random hash passes, as a float. */
  static passProbability(rawDiff, isOneChunkSolution, packingDifficulty = ConsensusConstants.REPLICA_2_9_PACKING_DIFFICULTY) {
    const blockDiff = isOneChunkSolution ? Difficulty.poa1(rawDiff) : rawDiff;
    const threshold = Difficulty.scaledForPackingDifficulty(blockDiff, packingDifficulty);
    const maxDiff = ConsensusConstants.MAX_DIFF;
    return Number(((maxDiff - threshold) * 10n ** 18n) / maxDiff) / 1e18;
  }
}

export class MiningIdentity {
  /**
   * Who mines. The 32-byte mining address is SHA-256 of the RSA public modulus; it
   * keys both the packing and H0. Mining only needs the address — the wallet (the
   * private key) matters only for signing a block or a transaction.
   */
  constructor(addressBytes, wallet = null) {
    if (addressBytes.length !== 32) throw new Error(`mining address must be 32 bytes, got ${addressBytes.length}`);
    this.addressBytes = addressBytes;
    this.wallet = wallet;
  }

  get address() {
    return Bytes.toBase64Url(this.addressBytes);
  }

  static fromAddress(addressText) {
    return new MiningIdentity(Bytes.fromBase64Url(addressText.trim()));
  }

  /** Mine for a wallet's own address (see src/wallet.js), keeping the wallet for signing. */
  static fromWallet(wallet) {
    return new MiningIdentity(wallet.addressBytes, wallet);
  }
}

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
    const sectorSize = ConsensusConstants.entropySectorSize;
    const partitionNumber = firstByte / ConsensusConstants.PARTITION_SIZE;
    const partitionEnd = (partitionNumber + 1n) * ConsensusConstants.PARTITION_SIZE;
    const limit = partitionEnd < weaveUpperBound ? partitionEnd : weaveUpperBound;
    const bytes = [];
    for (let byte = firstByte; byte < limit && bytes.length < count; byte += sectorSize) bytes.push(byte);
    return bytes;
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
   * cache. Real entropy is RandomxSquaredEntropySource (src/randomx.js). This stand-in
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

  async packChunk(chunkBytes, endOffset) {
    return (await this.packChunks([{ bytes: chunkBytes, endOffset }]))[0];
  }
}

export class StubH0Hasher {
  /**
   * STUB — not consensus-compatible; for browsers that cannot allocate the 512 MiB RandomX
   * cache. Real H0 is RandomxH0Hasher (src/randomx.js). Hashes the same preimage with
   * SHA-256 so everything after H0 still runs on real rules.
   */
  isStub = true;

  async hash(preimage) {
    return Sha256.hash(preimage);
  }
}

export class MiningMath {
  /**
   * The per-step mining computations (src/ar_block.erl compute_h0, compute_h1,
   * compute_h2, get_recall_range, get_recall_byte).
   */
  /** H0's input. Erlang's Seed:32/binary keeps the first 32 bytes of the 48-byte seed. */
  static h0Preimage(vdfOutput, partitionNumber, seed, addressBytes, packingDifficulty) {
    return Bytes.concat(vdfOutput, Bytes.fromBigInt(BigInt(partitionNumber), 32), seed.subarray(0, 32), addressBytes, new Uint8Array([packingDifficulty]));
  }

  /** Start bytes of the two recall ranges: one inside your partition, one anywhere. */
  static recallRangeStarts(h0, partitionNumber, partitionUpperBound) {
    const partitionSize = ConsensusConstants.PARTITION_SIZE;
    const offsetInPartition = Bytes.toBigInt(h0.subarray(0, 8));
    const range1Window = partitionSize < partitionUpperBound ? partitionSize : partitionUpperBound;
    const range1Start = BigInt(partitionNumber) * partitionSize + (offsetInPartition % range1Window);
    const range2Start = Bytes.toBigInt(h0) % partitionUpperBound;
    return [range1Start, range2Start];
  }

  /** The weave byte a nonce points at, and which of that chunk's 32 sub-chunks it uses. */
  static recallByteForNonce(rangeStart, nonce) {
    const chunkNumber = BigInt(Math.floor(nonce / ConsensusConstants.SUB_CHUNK_COUNT));
    return [rangeStart + chunkNumber * BigInt(ConsensusConstants.DATA_CHUNK_SIZE), nonce % ConsensusConstants.SUB_CHUNK_COUNT];
  }

  static h1(h0, nonce, subChunk1) {
    const preimage = Sha256.hash(h0, Bytes.fromBigInt(BigInt(nonce), 8), subChunk1);
    return { hash: Sha256.hash(h0, preimage), preimage };
  }

  /** Assumption: compute_h2 receives H1's solution hash (not its preimage). */
  static h2(h1Hash, subChunk2, h0) {
    const preimage = Sha256.hash(h1Hash, subChunk2);
    return { hash: Sha256.hash(h0, preimage), preimage };
  }
}

export class VdfSession {
  /**
   * The VDF context a miner works in, taken from a block's nonce_limiter_info: the
   * seed for H0, the weave-size bound for recall ranges, the difficulty, and step
   * outputs. A block's `checkpoints` list holds one output per step, newest first.
   */
  constructor({ seed, nextSeed, partitionUpperBound, vdfDifficulty, latestStepNumber, stepOutputsNewestFirst, networkDiff, height, blockRewardWinston }) {
    Object.assign(this, { seed, nextSeed, partitionUpperBound, vdfDifficulty, latestStepNumber, stepOutputsNewestFirst, networkDiff, height, blockRewardWinston });
  }

  static fromBlock(block) {
    const info = block.nonce_limiter_info;
    return new VdfSession({
      seed: Bytes.fromBase64Url(info.seed),
      nextSeed: Bytes.fromBase64Url(info.next_seed),
      // Approximation: the miner's upper bound is the session's zone_upper_bound; it can
      // change when a new session starts. Exact would track ar_nonce_limiter sessions.
      partitionUpperBound: BigInt(info.zone_upper_bound),
      vdfDifficulty: Number(info.vdf_difficulty),
      latestStepNumber: Number(info.global_step_number),
      stepOutputsNewestFirst: info.checkpoints.map(Bytes.fromBase64Url),
      networkDiff: BigInt(block.diff),
      height: Number(block.height),
      blockRewardWinston: BigInt(block.reward ?? 0),
    });
  }

  /** [stepNumber, output] pairs, oldest first; only steps after `afterStepNumber` if given. */
  steps(afterStepNumber = -1) {
    return this.stepOutputsNewestFirst
      .map((output, index) => [this.latestStepNumber - index, output])
      .filter(([stepNumber]) => stepNumber > afterStepNumber)
      .reverse();
  }
}

export class HeldStorage {
  /**
   * The packed chunks this node holds, keyed by bucket end offset, each one 256 KiB buffer
   * of 32 packed sub-chunks. A real node keeps terabytes on disk; a tab keeps what its
   * browser storage allows (see src/storage.js).
   */
  constructor() {
    this.packedChunks = new Map();
  }

  add(bucketEndOffset, packedChunk) {
    this.packedChunks.set(bucketEndOffset.toString(), packedChunk);
  }

  subChunkForByte(weaveByte, subChunkIndex) {
    const packed = this.packedChunks.get(Replica29Layout.bucketEndOffsetForByte(weaveByte).toString());
    if (!packed) return null;
    const size = ConsensusConstants.SUB_CHUNK_SIZE;
    return packed.subarray(subChunkIndex * size, (subChunkIndex + 1) * size);
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

export class Miner {
  /**
   * One mining node: for each VDF step it computes H0, finds both recall ranges, and
   * for every nonce whose data it holds computes H1 (and H2 if it also holds the
   * range-2 data), checking each against the network difficulty.
   *
   * Each report carries a `trace`: the intermediate values of the step, for checking by
   * hand against the node source (see src/citations.js).
   *
   * testMode exists only to exercise the H1/H2 path, which real data reaches about
   * never: aimRange1AtHeldData moves range 1 onto held data, and difficultyEase
   * multiplies the pass probability. Results found with it are not solutions.
   */
  constructor({ identity, partitionNumber, storage, h0Hasher, testMode = { aimRange1AtHeldData: false, difficultyEase: 1 } }) {
    Object.assign(this, { identity, partitionNumber, storage, h0Hasher, testMode });
  }

  easedPasses(hash, isOneChunkSolution, networkDiff) {
    if (this.testMode.difficultyEase === 1) return Difficulty.passes(hash, isOneChunkSolution, networkDiff);
    const probability = Math.min(1, Difficulty.passProbability(networkDiff, isOneChunkSolution) * this.testMode.difficultyEase);
    const hashFraction = Number(Bytes.toBigInt(hash.subarray(0, 8))) / 2 ** 64;
    return hashFraction > 1 - probability;
  }

  async mineStep(session, stepNumber, vdfOutput) {
    const packingDifficulty = ConsensusConstants.REPLICA_2_9_PACKING_DIFFICULTY;
    const h0Preimage = MiningMath.h0Preimage(vdfOutput, this.partitionNumber, session.seed, this.identity.addressBytes, packingDifficulty);
    const h0 = await this.h0Hasher.hash(h0Preimage);
    let [range1Start, range2Start] = MiningMath.recallRangeStarts(h0, this.partitionNumber, session.partitionUpperBound);
    if (this.testMode.aimRange1AtHeldData) {
      const firstHeld = this.storage.packedChunks.keys().next().value;
      if (firstHeld) range1Start = BigInt(firstHeld) - BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
    }

    const trace = {
      vdfOutput, partitionNumber: this.partitionNumber, seed: session.seed.subarray(0, 32), address: this.identity.addressBytes,
      packingDifficulty, h0Preimage, h0, h0IsStub: this.h0Hasher.isStub, range1Start, range2Start, firstHeldNonce: null,
    };
    const report = { stepNumber, h0, range1Start, range2Start, noncesTried: 0, h2Tried: 0, solution: null, trace };
    for (let nonce = 0; nonce < ConsensusConstants.noncesPerRecallRange; nonce++) {
      const [recallByte1, subChunkIndex] = MiningMath.recallByteForNonce(range1Start, nonce);
      const subChunk1 = this.storage.subChunkForByte(recallByte1, subChunkIndex);
      if (!subChunk1) continue;

      report.noncesTried++;
      const h1 = MiningMath.h1(h0, nonce, subChunk1);
      const [recallByte2] = MiningMath.recallByteForNonce(range2Start, nonce);
      const subChunk2 = this.storage.subChunkForByte(recallByte2, subChunkIndex);
      const h2 = subChunk2 ? MiningMath.h2(h1.hash, subChunk2, h0) : null;
      if (!trace.firstHeldNonce) trace.firstHeldNonce = { nonce, recallByte1, recallByte2, subChunkIndex, h1, h2 };

      if (this.easedPasses(h1.hash, true, session.networkDiff)) {
        report.solution = { kind: 'one-chunk (H1)', nonce, hash: h1.hash, recallByte1 };
        break;
      }
      if (!h2) continue;

      report.h2Tried++;
      if (this.easedPasses(h2.hash, false, session.networkDiff)) {
        report.solution = { kind: 'two-chunk (H2)', nonce, hash: h2.hash, recallByte1, recallByte2 };
        break;
      }
    }
    return report;
  }
}

export class SolutionOdds {
  /**
   * Expected waiting time for a real solution with the storage held, from the same rules
   * the miner applies. Each held nonce gives an H1 try (100 times harder), plus an H2 try
   * when its range-2 location is also held.
   */
  static NETWORK_STEPS_PER_SECOND = 1; // the VDF difficulty is retargeted toward one step a second

  static rates({ storage, partitionNumber, session }) {
    const partitionWindow = Number(session.partitionUpperBound < ConsensusConstants.PARTITION_SIZE ? session.partitionUpperBound : ConsensusConstants.PARTITION_SIZE);
    return {
      heldFractionOfPartition: storage.bytesInPartition(partitionNumber) / partitionWindow,
      heldFractionOfWeave: storage.byteCount / Number(session.partitionUpperBound),
      h1Probability: Difficulty.passProbability(session.networkDiff, true),
      h2Probability: Difficulty.passProbability(session.networkDiff, false),
    };
  }

  static solutionsPerStep({ heldFractionOfPartition, heldFractionOfWeave, h1Probability, h2Probability }) {
    return ConsensusConstants.noncesPerRecallRange * heldFractionOfPartition * (h1Probability + heldFractionOfWeave * h2Probability);
  }

  static expectedSecondsPerSolution({ storage, partitionNumber, session, stepsPerSecond = SolutionOdds.NETWORK_STEPS_PER_SECOND }) {
    const perStep = SolutionOdds.solutionsPerStep(SolutionOdds.rates({ storage, partitionNumber, session }));
    return perStep > 0 ? 1 / (perStep * stepsPerSecond) : Infinity;
  }

  /**
   * Why the wait is as long as it is, as factors that multiply: the wait of a miner that
   * holds the whole partition and the whole weave at the network's pace, times one factor
   * per shortfall. Each factor is how many times shorter the wait would be if only that
   * shortfall were removed; all of them together give the wait itself.
   *
   * `quotaBytes` (optional) is how much this browser lets the tab store; with it, the
   * storage factor also says how far the tab itself could bring it down.
   */
  static waitBreakdown({ storage, partitionNumber, session, stepsPerSecond = SolutionOdds.NETWORK_STEPS_PER_SECOND, quotaBytes = null }) {
    const rates = SolutionOdds.rates({ storage, partitionNumber, session });
    const fullSpeedPerStep = SolutionOdds.solutionsPerStep({ ...rates, heldFractionOfPartition: 1, heldFractionOfWeave: 1 });
    const fullSpeedSeconds = 1 / (fullSpeedPerStep * SolutionOdds.NETWORK_STEPS_PER_SECOND);
    const partitionWindow = rates.heldFractionOfPartition > 0 ? storage.bytesInPartition(partitionNumber) / rates.heldFractionOfPartition : Number(ConsensusConstants.PARTITION_SIZE);
    const factors = [];

    let storageNote = `holding ${(rates.heldFractionOfPartition * 100).toPrecision(2)}% of partition ${partitionNumber}`;
    if (quotaBytes) {
      const mostHeld = Math.min(quotaBytes, partitionWindow);
      storageNote += `; this browser allows about ${PrettyNumber.bytes(quotaBytes)}, so the most this tab could reach is ×${PrettyNumber.factor(partitionWindow / mostHeld)}`;
    }
    factors.push({ name: 'storage', multiplier: rates.heldFractionOfPartition > 0 ? 1 / rates.heldFractionOfPartition : Infinity, explanation: storageNote });

    const withCoverage = rates.h1Probability + rates.heldFractionOfWeave * rates.h2Probability;
    factors.push({ name: 'coverage', multiplier: (rates.h1Probability + rates.h2Probability) / withCoverage,
      explanation: `two-chunk tries need range 2 held too, which happens ${(rates.heldFractionOfWeave * 100).toPrecision(2)}% of the time; they pass 100× more often than one-chunk tries` });

    factors.push({ name: 'VDF pace', multiplier: SolutionOdds.NETWORK_STEPS_PER_SECOND / stepsPerSecond,
      explanation: `${stepsPerSecond >= 1 ? 'keeping up with' : `${(1 / stepsPerSecond).toFixed(1)} s per step against`} the network's one step a second` });

    const seconds = factors.reduce((product, factor) => product * factor.multiplier, fullSpeedSeconds);
    return { fullSpeedSeconds, factors, seconds };
  }

  /**
   * The chance that one step's range 1 touches any held chunk, so that at least one
   * one-chunk try happens. Range 1 starts uniformly in the partition and covers
   * RECALL_RANGE bytes; it touches a held chunk ending at e when it starts within
   * (e - chunk - range, e). The union of those windows over all held chunks, divided by
   * the partition, is the chance. Held chunks next to each other share windows, so this
   * depends on where the chunks are, not only how many.
   */
  static heldRangeHitChance({ storage, partitionNumber, session }) {
    const partitionStart = BigInt(partitionNumber) * ConsensusConstants.PARTITION_SIZE;
    const window = Number(session.partitionUpperBound < ConsensusConstants.PARTITION_SIZE ? session.partitionUpperBound : ConsensusConstants.PARTITION_SIZE);
    const reach = ConsensusConstants.DATA_CHUNK_SIZE + ConsensusConstants.recallRangeSize;
    const ends = [...storage.packedChunks.keys()].map(BigInt)
      .filter((end) => (end - 1n) / ConsensusConstants.PARTITION_SIZE === BigInt(partitionNumber))
      .map((end) => Number(end - partitionStart)).sort((left, right) => left - right);
    let covered = 0;
    let runStart = null;
    let runEnd = null;
    for (const end of ends) {
      const start = Math.max(0, end - reach);
      if (runEnd !== null && start <= runEnd) {
        runEnd = Math.max(runEnd, end);
      } else {
        if (runEnd !== null) covered += runEnd - runStart;
        runStart = start;
        runEnd = end;
      }
    }
    if (runEnd !== null) covered += runEnd - runStart;
    return Math.min(1, covered / window);
  }

  /**
   * The same estimate for a group pooling `storedBytes` of distinct data under one
   * address, packed in whole partitions (the best case for the squared bonus).
   */
  static forPooledStorage({ storedBytes, session, stepsPerSecond = SolutionOdds.NETWORK_STEPS_PER_SECOND }) {
    const partitionsCovered = storedBytes / Number(ConsensusConstants.PARTITION_SIZE);
    const weaveFraction = Math.min(1, storedBytes / Number(session.partitionUpperBound));
    const h1Probability = Difficulty.passProbability(session.networkDiff, true);
    const h2Probability = Difficulty.passProbability(session.networkDiff, false);
    const solutionsPerSecond = partitionsCovered * ConsensusConstants.noncesPerRecallRange * (h1Probability + weaveFraction * h2Probability) * stepsPerSecond;
    const winstonPerSecond = solutionsPerSecond * Number(session.blockRewardWinston);
    return { secondsPerBlock: solutionsPerSecond > 0 ? 1 / solutionsPerSecond : Infinity, arPerDay: (winstonPerSecond * 86_400) / 1e12 };
  }

  /**
   * Average days until a pool member's earnings, after the pool's fee, reach the pool's
   * payout threshold. With PPLNS (pay per last N shares) this is the long-run average; the
   * pool pays only when it finds a block, so real payouts come in lumps around it.
   */
  static daysToPayout({ memberArPerDay, feeFraction, thresholdAr }) {
    const keptPerDay = memberArPerDay * (1 - feeFraction);
    return keptPerDay > 0 ? thresholdAr / keptPerDay : Infinity;
  }
}

export class PrettyNumber {
  /**
   * Short readable multipliers and durations for status text.
   */
  static factor(value) {
    if (!isFinite(value)) return '∞';
    return value < 10 ? value.toPrecision(2) : value < 1e6 ? Math.round(value).toLocaleString() : value.toExponential(1).replace('e+', ' × 10^');
  }

  static bytes(count) {
    const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (count >= 1024 && unit < units.length - 1) { count /= 1024; unit++; }
    return `${count.toPrecision(3)} ${units[unit]}`;
  }

  static times(value) {
    if (!isFinite(value)) return 'infinitely';
    return value < 1e6 ? `${Math.round(value).toLocaleString()}×` : `${value.toExponential(1).replace('e+', ' × 10^')}×`;
  }
}
