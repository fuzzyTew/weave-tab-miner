// src/blocks/solution.js — a block's solution fields (BlockAssembler.SOLUTION_FIELDS) from one
// held chunk: its sub-chunk packed for the miner, H0 and H1, and the proofs. Part of step 6
// of docs/TODO.md "Turn a solution into a block".
import { Bytes } from '../core/bytes.js';
import { ConsensusConstants } from '../core/constants.js';
import { MiningMath } from '../mining/mining-math.js';
import { Replica29Layout } from '../mining/packing.js';
import { Sha256 } from '../core/sha256.js';
import { SegmentWriter } from './hash.js';

export class VdfInfo {
  /**
   * A new block's nonce_limiter_info on the parent's own VDF step. Only a localnet accepts
   * that (ar_nonce_limiter's LOCALNET rules allow a block on its parent's step and validate
   * that the steps match); on mainnet a block must be on a later step, with the steps
   * between listed — not built yet.
   */
  static sameStepAsParent(parent) {
    // The parent's step, output, steps ("checkpoints") and last-step checkpoints, with the
    // parent's output as this block's prev_output (ar_block_pre_validator requires
    // prev_output to be the parent's output on any step).
    const info = JSON.parse(JSON.stringify(parent.nonce_limiter_info));
    info.prev_output = info.output;
    return info;
  }
}

export class OneChunkSolution {
  /** Arweave's replica 2.9 packing, as block JSON names it. */
  static PACKING_DIFFICULTY = 10;
  static REPLICA_FORMAT = 1;

  /**
   * A one-chunk solution from the chunk starting at `recallByte` (chunk-aligned, BigInt):
   * `chunkJson` is GET /chunk's answer for it, unpacked ({ chunk, data_path, tx_path },
   * base64url). `nonce` (0–31) picks the sub-chunk. `seed` is the parent's VDF seed (48
   * bytes); `h0Hasher` and `entropySource` come from src/mining/randomx.js.
   *
   * Approximation: the recall range is taken to start at this chunk, which only a localnet
   * allows (a block there names its recall byte). On mainnet the range comes from H0 and
   * the solution must also pass the difficulty, which callers check.
   */
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

  static async build({ addressBytes, vdfInfo, seed, recallByte, chunkJson, nonce, h0Hasher, entropySource }) {
    const size = ConsensusConstants.SUB_CHUNK_SIZE;
    const unpacked = OneChunkSolution.padded(Bytes.fromBase64Url(chunkJson.chunk));

    // Pack just the proven sub-chunk: it needs one 8 MiB entropy, not a whole chunk's 32.
    const endOffset = Replica29Layout.bucketEndOffsetForByte(recallByte);
    const entropy = await entropySource.entropy(Replica29Layout.entropyKey(addressBytes, endOffset, nonce * size));
    const slice = entropy.subarray(Replica29Layout.sliceIndex(endOffset) * size, (Replica29Layout.sliceIndex(endOffset) + 1) * size);
    const packedSubChunk = unpacked.subarray(nonce * size, (nonce + 1) * size).map((byte, index) => byte ^ slice[index]);

    const partitionNumber = Number(recallByte / ConsensusConstants.PARTITION_SIZE);
    const h0 = await h0Hasher.hash(MiningMath.h0Preimage(Bytes.fromBase64Url(vdfInfo.output), partitionNumber, seed, addressBytes, OneChunkSolution.PACKING_DIFFICULTY));
    const h1 = MiningMath.h1(h0, nonce, packedSubChunk);
    return {
      nonce: Bytes.toBase64Url(SegmentWriter.unsigned(nonce)),
      hash: Bytes.toBase64Url(h1.hash),
      hash_preimage: Bytes.toBase64Url(h1.preimage),
      recall_byte: recallByte.toString(),
      partition_number: partitionNumber,
      nonce_limiter_info: vdfInfo,
      poa: { option: '1', tx_path: chunkJson.tx_path, data_path: chunkJson.data_path, chunk: Bytes.toBase64Url(packedSubChunk), unpacked_chunk: Bytes.toBase64Url(unpacked) },
      poa2: { option: '1', tx_path: '', data_path: '', chunk: '' },
      chunk_hash: Bytes.toBase64Url(Sha256.hash(packedSubChunk)),
      unpacked_chunk_hash: Bytes.toBase64Url(Sha256.hash(unpacked)),
      packing_difficulty: OneChunkSolution.PACKING_DIFFICULTY,
      replica_format: OneChunkSolution.REPLICA_FORMAT,
    };
  }
}

