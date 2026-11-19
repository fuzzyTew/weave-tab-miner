// src/mining/miner.js — The miner: one VDF step tried against held data.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { Bytes } from '../core/bytes.js';
import { ConsensusConstants } from '../core/constants.js';
import { Difficulty } from './difficulty.js';
import { HeldStorage } from './held-storage.js';
import { MiningMath } from './mining-math.js';

export class Miner {
  /**
   * One mining node: for each VDF step it computes H0, finds both recall ranges, and
   * for every nonce whose data it holds computes H1 (and H2 if it also holds the
   * range-2 data), checking each against the network difficulty.
   *
   * Each report carries a `trace`: the intermediate values of the step, for checking by
   * hand against the node source (see src/core/citations.js).
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

    // Held chunks may be on disk only (HeldStorage.ensureLoaded): read in the ones both
    // ranges touch before trying their nonces.
    const chunksPerRange = ConsensusConstants.noncesPerRecallRange / ConsensusConstants.SUB_CHUNK_COUNT;
    const rangeBytes = [];
    for (let chunk = 0; chunk < chunksPerRange; chunk++) {
      for (const start of [range1Start, range2Start]) rangeBytes.push(MiningMath.recallByteForNonce(start, chunk * ConsensusConstants.SUB_CHUNK_COUNT)[0]);
    }
    await this.storage.ensureLoaded(rangeBytes);

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
