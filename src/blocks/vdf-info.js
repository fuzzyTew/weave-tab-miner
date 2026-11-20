// src/blocks/vdf-info.js — a new block's nonce_limiter_info: the VDF step it was mined on, the
// steps since its parent, and the seeds and VDF difficulty that step falls under.
// Rules from ar_node_worker (block assembly), ar_nonce_limiter (seeds, resets, validation)
// and ar_block:compute_next_vdf_difficulty.
import { Bytes } from '../core/bytes.js';
import { ConsensusConstants } from '../core/constants.js';
import { VdfChain } from '../mining/vdf.js';

export class ComputedVdfSteps {
  /**
   * A step source that computes every step itself with VdfChain (in JavaScript, about 8 s
   * a step at the localnet's VDF difficulty). A step source answers
   * `checkpoints({ stepNumber, previousOutput, vdfDifficulty, resetSeed })` with the step's
   * 25 checkpoints, oldest first, and `output(...)` (same arguments) with its last one.
   * `resetSeed` is set only on the step at an entropy reset line.
   */
  constructor() {
    this.chains = new Map();
  }

  chain(vdfDifficulty) {
    if (!this.chains.has(vdfDifficulty)) this.chains.set(vdfDifficulty, new VdfChain({ iterationsPerCheckpoint: vdfDifficulty }));
    return this.chains.get(vdfDifficulty);
  }

  async checkpoints({ stepNumber, previousOutput, vdfDifficulty, resetSeed }) {
    return this.chain(vdfDifficulty).computeStep(stepNumber, previousOutput, resetSeed);
  }

  async output(request) {
    return (await this.checkpoints(request)).at(-1);
  }
}

export class RecordedVdfSteps {
  /**
   * A step source that already holds some step outputs (from a VDF server, or a block's
   * own `checkpoints` list), as a Map of step number to output, and asks `fallback` for
   * anything else. Checkpoints within a step are always asked of `fallback`.
   */
  constructor(outputsByStep, fallback = new ComputedVdfSteps()) {
    Object.assign(this, { outputsByStep, fallback });
  }

  static fromBlock(block, fallback) {
    const info = block.nonce_limiter_info;
    return new RecordedVdfSteps(new Map(info.checkpoints.map((output, index) => [Number(info.global_step_number) - index, Bytes.fromBase64Url(output)])), fallback);
  }

  async checkpoints(request) {
    return this.fallback.checkpoints(request);
  }

  async output(request) {
    return this.outputsByStep.get(request.stepNumber) ?? this.fallback.output(request);
  }
}

export class VdfInfo {
  /** ?NONCE_LIMITER_MAX_CHECKPOINTS_COUNT: a block lists at most this many steps. */
  static MAX_LISTED_STEPS = 10800;
  /** ?VDF_DIFFICULTY_RETARGET and ?VDF_HISTORY_CUT (mainnet and localnet). */
  static VDF_DIFFICULTY_RETARGET = 720;
  static VDF_HISTORY_CUT = 50;
  static MIN_VDF_DIFFICULTY = 2n;

  /**
   * A new block's nonce_limiter_info on the parent's own VDF step. Only a localnet accepts
   * that (ar_nonce_limiter's LOCALNET rules allow a block on its parent's step and validate
   * that the steps match); on mainnet a block must be on a later step: see `afterParent`.
   */
  static sameStepAsParent(parent) {
    // The parent's step, output, steps ("checkpoints") and last-step checkpoints, with the
    // parent's output as this block's prev_output (ar_block_pre_validator requires
    // prev_output to be the parent's output on any step).
    const info = JSON.parse(JSON.stringify(parent.nonce_limiter_info));
    info.prev_output = info.output;
    return info;
  }

  /**
   * The entropy reset line crossed going from `previousStep` to `step`, or null
   * (ar_nonce_limiter:get_entropy_reset_point): the first multiple of the reset frequency
   * after `previousStep`, if `step` reaches it.
   */
  static resetPoint(previousStep, step) {
    const frequency = ConsensusConstants.NONCE_LIMITER_RESET_FREQUENCY;
    const line = (Math.floor(previousStep / frequency) + 1) * frequency;
    return line > step ? null : line;
  }

  /**
   * The seeds, zone bounds and VDF difficulty of a block on `step` over `parent`
   * (ar_nonce_limiter:get_seed_data): the parent's, unless a reset line was crossed; then
   * the "next" ones move up, and the parent's id and weave size become the new "next".
   */
  static seedData(parent, step) {
    const info = parent.nonce_limiter_info;
    if (VdfInfo.resetPoint(Number(info.global_step_number), step) === null) {
      return { seed: info.seed, next_seed: info.next_seed, zone_upper_bound: info.zone_upper_bound, next_zone_upper_bound: info.next_zone_upper_bound, vdf_difficulty: info.vdf_difficulty };
    }
    return { seed: info.next_seed, next_seed: parent.indep_hash, zone_upper_bound: info.next_zone_upper_bound, // Block JSON has bounds as numbers; exact while the weave is under 2^53 bytes (8 PiB).
      next_zone_upper_bound: Number(parent.weave_size), vdf_difficulty: info.next_vdf_difficulty };
  }

  /**
   * The VDF difficulty a block schedules for after the next reset line
   * (ar_block:compute_next_vdf_difficulty, from fork 2.7.1): every 720 heights, when the
   * last scheduled change has taken effect, a tenth of the way (an exponential moving
   * average) towards the difficulty that would have made the VDF keep pace with blocks
   * over 720 recent blocks, skipping the newest 50.
   */
  static nextVdfDifficulty(parent, parentBlockTimeHistory) {
    const info = parent.nonce_limiter_info;
    const height = Number(parent.height) + 1;
    const vdfDifficulty = BigInt(info.vdf_difficulty);
    if (height % VdfInfo.VDF_DIFFICULTY_RETARGET !== 0 || vdfDifficulty !== BigInt(info.next_vdf_difficulty)) return info.next_vdf_difficulty;
    const window = parentBlockTimeHistory.entries.slice(VdfInfo.VDF_HISTORY_CUT, VdfInfo.VDF_HISTORY_CUT + VdfInfo.VDF_DIFFICULTY_RETARGET);
    const intervalTotal = window.reduce((total, entry) => total + entry.blockInterval, 0n);
    const vdfIntervalTotal = window.reduce((total, entry) => total + entry.vdfInterval, 0n);
    const target = vdfIntervalTotal * vdfDifficulty / intervalTotal;
    const average = (9n * vdfDifficulty + target) / 10n;
    return (average > VdfInfo.MIN_VDF_DIFFICULTY ? average : VdfInfo.MIN_VDF_DIFFICULTY).toString();
  }

  /**
   * nonce_limiter_info for a block on VDF step `stepNumber`, after its parent's step. The
   * steps between come from `stepSource` (ComputedVdfSteps, RecordedVdfSteps, or a VDF
   * server's); steps before a crossed reset line use the parent's VDF difficulty, the rest
   * the new one, and the step on the line mixes in the new seed.
   */
  static async afterParent({ parent, parentBlockTimeHistory, stepNumber, stepSource }) {
    const info = parent.nonce_limiter_info;
    const parentStep = Number(info.global_step_number);
    if (stepNumber <= parentStep) throw new Error(`step ${stepNumber} is not after the parent's step ${parentStep}`);
    const seedData = VdfInfo.seedData(parent, stepNumber);
    const resetPoint = VdfInfo.resetPoint(parentStep, stepNumber);
    const newSeed = Bytes.fromBase64Url(seedData.seed);

    // Outputs oldest first; only the newest MAX_LISTED_STEPS are listed, but all are computed.
    let previousOutput = Bytes.fromBase64Url(info.output);
    const outputs = [];
    let lastCheckpoints = null;
    for (let step = parentStep + 1; step <= stepNumber; step++) {
      const request = {
        stepNumber: step, previousOutput,
        vdfDifficulty: Number(resetPoint !== null && step >= resetPoint ? seedData.vdf_difficulty : info.vdf_difficulty),
        resetSeed: step === resetPoint ? newSeed : null,
      };
      if (step === stepNumber) {
        lastCheckpoints = await stepSource.checkpoints(request);
        previousOutput = lastCheckpoints.at(-1);
      } else {
        previousOutput = await stepSource.output(request);
      }
      outputs.push(previousOutput);
    }

    const newestFirst = (list) => list.slice().reverse().map(Bytes.toBase64Url);
    // In the field order nodes serve, so the JSON compares equal to theirs.
    return {
      output: Bytes.toBase64Url(previousOutput),
      global_step_number: stepNumber,
      seed: seedData.seed,
      next_seed: seedData.next_seed,
      zone_upper_bound: seedData.zone_upper_bound,
      next_zone_upper_bound: seedData.next_zone_upper_bound,
      prev_output: info.output,
      last_step_checkpoints: newestFirst(lastCheckpoints),
      checkpoints: newestFirst(outputs).slice(0, VdfInfo.MAX_LISTED_STEPS),
      vdf_difficulty: seedData.vdf_difficulty,
      next_vdf_difficulty: VdfInfo.nextVdfDifficulty(parent, parentBlockTimeHistory),
    };
  }
}
