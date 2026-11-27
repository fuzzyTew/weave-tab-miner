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
   * multiplies the pass probability (infinity: every hash passes). Results found with it
   * are not solutions on the mainnet, but are on a network whose rules allow the same
   * (NetworkRules.minerAllowance, as on a localnet).
   */
  constructor({ identity, partitionNumber, storage, h0Hasher, testMode = { aimRange1AtHeldData: false, difficultyEase: 1 } }) {
    Object.assign(this, { identity, partitionNumber, storage, h0Hasher, testMode });
  }

  easedPasses(hash, isOneChunkSolution, networkDiff) {
    if (this.testMode.difficultyEase === 1) return Difficulty.passes(hash, isOneChunkSolution, networkDiff);
    // Every hash passes (a network that does not check the difficulty, as a localnet).
    if (this.testMode.difficultyEase === Number.POSITIVE_INFINITY) return true;
    const probability = Math.min(1, Difficulty.passProbability(networkDiff, isOneChunkSolution) * this.testMode.difficultyEase);
    const hashFraction = Number(Bytes.toBigInt(hash.subarray(0, 8))) / 2 ** 64;
    return hashFraction > 1 - probability;
  }

  async mineStep(session, stepNumber, vdfOutput) {
    const startedAt = performance.now();
    const packingDifficulty = ConsensusConstants.REPLICA_2_9_PACKING_DIFFICULTY;
    const h0Preimage = MiningMath.h0Preimage(vdfOutput, this.partitionNumber, session.seed, this.identity.addressBytes, packingDifficulty);
    const h0 = await this.h0Hasher.hash(h0Preimage);
    let [range1Start, range2Start] = MiningMath.recallRangeStarts(h0, this.partitionNumber, session.partitionUpperBound);
    if (this.testMode.aimRange1AtHeldData) {
      // The held chunk's last byte: inside it whatever its size (a small chunk below the
      // strict data split threshold starts later than one chunk size before its end).
      const firstHeld = this.storage.firstHeldEnd();
      if (firstHeld !== null) range1Start = firstHeld - 1n;
    }

    const trace = {
      vdfOutput, partitionNumber: this.partitionNumber, seed: session.seed.subarray(0, 32), address: this.identity.addressBytes,
      packingDifficulty, h0Preimage, h0, h0IsStub: this.h0Hasher.isStub, range1Start, range2Start, firstHeldNonce: null,
    };
    // Where this step's time went, for the page's pace report.
    const timings = { h0Ms: performance.now() - startedAt, loadMs: 0, hashMs: 0, chunksRead: 0 };
    const report = { stepNumber, h0, range1Start, range2Start, noncesTried: 0, h2Tried: 0, solution: null, trace, timings };

    // Nonces run chunk by chunk (32 sub-chunks each), so a step needs only one chunk of
    // each range in memory at a time; held chunks may be on disk only
    // (HeldStorage.ensureLoaded). The next pair is read while this one is hashed.
    const subChunkCount = ConsensusConstants.SUB_CHUNK_COUNT;
    const chunksPerRange = ConsensusConstants.noncesPerRecallRange / subChunkCount;
    const chunkPairBytes = (chunk) => [range1Start, range2Start].map((start) => MiningMath.recallByteForNonce(start, chunk * subChunkCount)[0]);
    let pending = this.storage.ensureLoaded(chunkPairBytes(0));
    for (let chunk = 0; chunk < chunksPerRange && !report.solution; chunk++) {
      const loadStarted = performance.now();
      timings.chunksRead += await pending;
      timings.loadMs += performance.now() - loadStarted;
      // Pin this pair while the next is read: reading may push older chunks out of memory.
      const pinned = chunkPairBytes(chunk).map((byte) => this.storage.chunkForByte(byte));
      pending = chunk + 1 < chunksPerRange ? this.storage.ensureLoaded(chunkPairBytes(chunk + 1)) : Promise.resolve(0);

      const hashStarted = performance.now();
      for (let nonce = chunk * subChunkCount; nonce < (chunk + 1) * subChunkCount; nonce++) {
        const [recallByte1, subChunkIndex] = MiningMath.recallByteForNonce(range1Start, nonce);
        const subChunk1 = HeldStorage.subChunkOf(pinned[0], subChunkIndex);
        if (!subChunk1) continue;

        report.noncesTried++;
        const h1 = MiningMath.h1(h0, nonce, subChunk1);
        const [recallByte2] = MiningMath.recallByteForNonce(range2Start, nonce);
        const subChunk2 = HeldStorage.subChunkOf(pinned[1], subChunkIndex);
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
      timings.hashMs += performance.now() - hashStarted;
    }
    timings.chunksRead += await pending;
    timings.totalMs = performance.now() - startedAt;
    return report;
  }
}
