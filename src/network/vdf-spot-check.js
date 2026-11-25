// src/network/vdf-spot-check.js — checks VDF servers' steps by sampling: now and then, one
// checkpoint of a server's newest step is computed here and compared. A server sending
// made-up steps would otherwise have the tab mine on them for nothing.
import { ConsensusConstants } from '../core/constants.js';
import { Bytes } from '../core/bytes.js';
import { VdfChain } from '../mining/vdf.js';
import { VdfUpdate } from './vdf-client.js';

export class VdfSpotCheck {
  /**
   * `computeCheckpoint({ saltNumber, input, iterationsPerCheckpoint })` resolves one
   * checkpoint's output (in a worker, so the page stays free; about a second on mainnet,
   * a 25th of a step). `intervalMs` spaces checks, about 3% of a core at 30 s.
   * `pickIndex(count)` chooses which checkpoint (random by default).
   */
  constructor({ computeCheckpoint, intervalMs = 30_000, pickIndex = (count) => Math.floor(Math.random() * count) }) {
    Object.assign(this, { computeCheckpoint, intervalMs, pickIndex });
    this.lastCheckAt = -Infinity;
    this.checking = false;
  }

  /** Whether a check is due at `now` (milliseconds) and none is running. */
  due(now) {
    return !this.checking && now - this.lastCheckAt >= this.intervalMs;
  }

  /**
   * Checks one checkpoint of `update`'s newest step. Its input is the checkpoint before
   * (or, for the first, the previous step's output), with the salt ar_vdf:compute gives it;
   * the first checkpoint of a reset step mixes in a seed, so another is taken there.
   * `vdfDifficulties` are tried in turn (the block's, then the update's next one, since a
   * change takes effect at a reset line). Resolves { checked, matches, stepNumber, index }:
   * checked is false when the update carries too little to check.
   */
  async check(update, vdfDifficulties, now = Date.now()) {
    const checkpoints = VdfUpdate.lastStepCheckpoints(update);
    const previousOutput = update.stepsNewestFirst[1];
    const stepNumber = update.stepNumber;
    if (!checkpoints || !previousOutput) return { checked: false, stepNumber };

    const count = ConsensusConstants.VDF_CHECKPOINT_COUNT_IN_STEP;
    let index = this.pickIndex(count);
    if (index === 0 && VdfChain.isResetStep(stepNumber)) index = 1;
    const input = index === 0 ? previousOutput : checkpoints[index - 1];
    const saltNumber = VdfChain.saltNumberForStep(stepNumber - 1) + BigInt(index);

    this.checking = true;
    this.lastCheckAt = now;
    try {
      for (const iterationsPerCheckpoint of [...new Set(vdfDifficulties.map(Number))]) {
        const output = await this.computeCheckpoint({ saltNumber, input, iterationsPerCheckpoint });
        if (Bytes.equal(output, checkpoints[index])) return { checked: true, matches: true, stepNumber, index };
      }
      return { checked: true, matches: false, stepNumber, index };
    } finally {
      this.checking = false;
    }
  }
}
