// src/mining/vdf.js — The VDF: chained, salted SHA-256 steps with checkpoints, and the session a miner works in.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { Bytes } from '../core/bytes.js';
import { ConsensusConstants } from '../core/constants.js';
import { Sha256 } from '../core/sha256.js';

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

  /**
   * This session moved onto a VDF server's update (VdfUpdate.parse): its seeds and weave
   * bound change at every entropy reset line, about every 20 minutes, and H0 must use the
   * current ones or every solution is invalid.
   * Approximation: the bound is the update's session bound; a node picks next_upper_bound
   * for steps past the reset point within a session (get_active_partition_upper_bound).
   */
  withVdfUpdate(update) {
    return new VdfSession({ ...this, seed: update.seed, nextSeed: update.nextSeed, partitionUpperBound: update.upperBound });
  }

  /** [stepNumber, output] pairs, oldest first; only steps after `afterStepNumber` if given. */
  steps(afterStepNumber = -1) {
    return this.stepOutputsNewestFirst
      .map((output, index) => [this.latestStepNumber - index, output])
      .filter(([stepNumber]) => stepNumber > afterStepNumber)
      .reverse();
  }
}
