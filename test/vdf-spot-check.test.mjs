// test/vdf-spot-check.test.mjs — VdfSpotCheck on VDF steps as a server would send them: a
// step computed here at low difficulty is recomputed by the check and matches (the VDF at
// mainnet difficulty is checked in test/against-block.test.mjs, a second per checkpoint),
// the sample block's step with one checkpoint altered does not, and checks are spaced.
// Run: node test/vdf-spot-check.test.mjs
import { readFileSync } from 'node:fs';
import { Bytes } from '../src/core/bytes.js';
import { VdfChain } from '../src/mining/vdf.js';
import { VdfSpotCheck } from '../src/network/vdf-spot-check.js';
import { TestCase } from './test-case.mjs';

class VdfSpotCheckTest extends TestCase {

  /** The sample block's newest step as a VDF server update carries it (both lists newest first). */
  static updateFromBlock(block) {
    const info = block.nonce_limiter_info;
    return {
      stepNumber: Number(info.global_step_number),
      stepsNewestFirst: info.checkpoints.map(Bytes.fromBase64Url),
      checkpoints: info.last_step_checkpoints.map(Bytes.fromBase64Url),
    };
  }

  async run() {
    const block = JSON.parse(readFileSync(new URL('../data/sample-block.json', import.meta.url), 'utf8'));
    const update = VdfSpotCheckTest.updateFromBlock(block);
    const difficulty = Number(block.nonce_limiter_info.vdf_difficulty);

    // A real chain at low difficulty: the check must pick the same salt and input to match.
    const iterations = 1000;
    const stepNumber = Number(block.nonce_limiter_info.global_step_number);
    const previousOutput = update.stepsNewestFirst[1];
    const computed = new VdfChain({ iterationsPerCheckpoint: iterations }).computeStep(stepNumber, previousOutput);
    const lowDifficultyUpdate = { stepNumber, stepsNewestFirst: [computed.at(-1), previousOutput], checkpoints: computed.slice().reverse() };
    const real = new VdfSpotCheck({
      computeCheckpoint: async ({ saltNumber, input, iterationsPerCheckpoint }) => new VdfChain({ iterationsPerCheckpoint }).computeCheckpoint(saltNumber, input),
      pickIndex: () => 7,
    });
    const result = await real.check(lowDifficultyUpdate, [iterations], 0);
    const firstResult = await new VdfSpotCheck({ computeCheckpoint: real.computeCheckpoint, pickIndex: () => 0 }).check(lowDifficultyUpdate, [iterations], 0);
    this.report('a step\'s checkpoint, recomputed here from the right salt and input, matches', result.checked && result.matches && firstResult.matches,
      `step ${result.stepNumber}, checkpoints ${result.index} and ${firstResult.index}`);
    const wrongDifficulty = await new VdfSpotCheck({ computeCheckpoint: real.computeCheckpoint, pickIndex: () => 7 }).check(lowDifficultyUpdate, [iterations + 1], 0);
    this.report('under the wrong difficulty it does not match', wrongDifficulty.checked && !wrongDifficulty.matches);
    this.report('the next check waits its interval', !real.due(1000) && real.due(real.intervalMs));

    // A server altering one checkpoint: the stand-in returns what the real chain would have.
    const altered = { ...update, checkpoints: update.checkpoints.slice() };
    altered.checkpoints[24 - 3] = new Uint8Array(32).fill(9); // newest first: index 3 oldest-first
    const expectedAtThree = update.checkpoints[24 - 3];
    const standIn = new VdfSpotCheck({ computeCheckpoint: async () => expectedAtThree, pickIndex: () => 3 });
    const caught = await standIn.check(altered, [difficulty, difficulty + 1], 0);
    this.report('an altered checkpoint is caught, under every difficulty tried', caught.checked && !caught.matches);

    const tooLittle = await standIn.check({ ...update, checkpoints: [] }, [difficulty], 0);
    this.report('an update without its step\'s checkpoints is not counted as checked', tooLittle.checked === false);
    this.finish();
  }
}

await new VdfSpotCheckTest().run();
