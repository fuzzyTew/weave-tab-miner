// src/blocks/solution.js — a block's solution fields (BlockAssembler.SOLUTION_FIELDS) from one
// or two held chunks: their proven sub-chunks packed for the miner, H0, H1 (and H2), and the
// proofs. Step 6 of docs/TODO.md "Turn a solution into a block".
import { Bytes } from '../core/bytes.js';
import { ConsensusConstants } from '../core/constants.js';
import { MiningMath } from '../mining/mining-math.js';
import { Replica29Layout } from '../mining/packing.js';
import { Sha256 } from '../core/sha256.js';
import { SegmentWriter } from './hash.js';

export class BlockSolution {
  /** Arweave's replica 2.9 packing, as block JSON names it. */
  static PACKING_DIFFICULTY = 10;
  static REPLICA_FORMAT = 1;

  /**
   * A chunk as replica 2.9 packs and proves it: a small chunk (under 256 KiB, as at the end
   * of a transaction's data) is zero-padded to 256 KiB, and the padded bytes are the
   * block's unpacked_chunk and what unpacked_chunk_hash covers.
   */
  static padded(unpacked) {
    const size = ConsensusConstants.DATA_CHUNK_SIZE;
    if (unpacked.length > size) throw new Error(`chunk is ${unpacked.length} bytes, over ${size}`);
    if (unpacked.length === size) return unpacked;
    const padded = new Uint8Array(size);
    padded.set(unpacked);
    return padded;
  }

  /**
   * The sub-chunk `nonce` picks in the chunk at `recallByte`, packed for `addressBytes`, with the
   * chunk's proof: { packedSubChunk, unpacked, poa }. Only that sub-chunk is packed, which
   * needs one 8 MiB entropy, not a whole chunk's 32.
   */
  static async provenSubChunk({ addressBytes, recallByte, chunkJson, nonce, entropySource }) {
    const size = ConsensusConstants.SUB_CHUNK_SIZE;
    // Nonces run across a recall range's chunks, 32 sub-chunks each: the chunk is picked by
    // the recall byte, the sub-chunk within it by the nonce's remainder.
    const subChunkIndex = nonce % ConsensusConstants.SUB_CHUNK_COUNT;
    const unpacked = BlockSolution.padded(Bytes.fromBase64Url(chunkJson.chunk));
    const endOffset = Replica29Layout.chunkEndOffset(chunkJson, recallByte);
    const entropy = await entropySource.entropy(Replica29Layout.entropyKey(addressBytes, endOffset, subChunkIndex * size));
    const slice = entropy.subarray(Replica29Layout.sliceIndex(endOffset) * size, (Replica29Layout.sliceIndex(endOffset) + 1) * size);
    const packedSubChunk = unpacked.subarray(subChunkIndex * size, (subChunkIndex + 1) * size).map((byte, index) => byte ^ slice[index]);
    return {
      packedSubChunk, unpacked,
      poa: { option: '1', tx_path: chunkJson.tx_path, data_path: chunkJson.data_path, chunk: Bytes.toBase64Url(packedSubChunk), unpacked_chunk: Bytes.toBase64Url(unpacked) },
    };
  }

  /**
   * A solution from the chunk starting at `recallByte` (chunk-aligned, BigInt) and, for a
   * two-chunk solution, the one at `recallByte2`. `chunkJson` and `chunk2Json` are GET
   * /chunk's answers for them, unpacked ({ chunk, data_path, tx_path }, base64url). `nonce`
   * is the miner's (it counts sub-chunks across the recall range, so its remainder by 32
   * picks the sub-chunk in each chunk). `seed` is the parent block's VDF seed (48 bytes; ar_block:compute_h0 takes the parent's);
   * `h0Hasher` and `entropySource` come from src/mining/randomx.js. With two chunks the
   * solution hash is H2, over H1 and the second sub-chunk (ar_block:compute_h2).
   *
   * Approximation: the recall ranges are taken to start at these chunks, which only a
   * localnet allows (a block there names its recall bytes). On mainnet the ranges come from
   * H0 and the solution must also pass the difficulty, which callers check.
   */
  static async build({ addressBytes, vdfInfo, seed, recallByte, chunkJson, recallByte2, chunk2Json, nonce, h0Hasher, entropySource }) {
    const first = await BlockSolution.provenSubChunk({ addressBytes, recallByte, chunkJson, nonce, entropySource });
    const partitionNumber = Number(recallByte / ConsensusConstants.PARTITION_SIZE);
    const h0 = await h0Hasher.hash(MiningMath.h0Preimage(Bytes.fromBase64Url(vdfInfo.output), partitionNumber, seed, addressBytes, BlockSolution.PACKING_DIFFICULTY));
    const h1 = MiningMath.h1(h0, nonce, first.packedSubChunk);
    const second = recallByte2 === undefined ? null : await BlockSolution.provenSubChunk({ addressBytes, recallByte: recallByte2, chunkJson: chunk2Json, nonce, entropySource });
    const solutionHash = second ? MiningMath.h2(h1.hash, second.packedSubChunk, h0) : h1;
    return {
      nonce: Bytes.toBase64Url(SegmentWriter.unsigned(nonce)),
      hash: Bytes.toBase64Url(solutionHash.hash),
      hash_preimage: Bytes.toBase64Url(solutionHash.preimage),
      recall_byte: recallByte.toString(),
      ...(second ? { recall_byte2: recallByte2.toString() } : {}),
      partition_number: partitionNumber,
      nonce_limiter_info: vdfInfo,
      poa: first.poa,
      poa2: second ? second.poa : { option: '1', tx_path: '', data_path: '', chunk: '' },
      chunk_hash: Bytes.toBase64Url(Sha256.hash(first.packedSubChunk)),
      ...(second ? { chunk2_hash: Bytes.toBase64Url(Sha256.hash(second.packedSubChunk)) } : {}),
      unpacked_chunk_hash: Bytes.toBase64Url(Sha256.hash(first.unpacked)),
      ...(second ? { unpacked_chunk2_hash: Bytes.toBase64Url(Sha256.hash(second.unpacked)) } : {}),
      packing_difficulty: BlockSolution.PACKING_DIFFICULTY,
      replica_format: BlockSolution.REPLICA_FORMAT,
    };
  }
}
