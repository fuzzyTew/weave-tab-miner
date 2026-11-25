// test/vdf-spot-check.test.mjs — VdfSpotCheck on the bundled sample block's VDF steps, as a
// server would send them: one real checkpoint matches (computed at mainnet difficulty,
// about a second), a server's altered checkpoint does not (with a stand-in computation),
// and checks are spaced. Run: node test/vdf-spot-check.test.mjs
import { readFileSync } from 'node:fs';
import { Bytes } from '../src/core/bytes.js';
import { VdfChain } from '../src/mining/vdf.js';
import { VdfSpotCheck } from '../src/network/vdf-spot-check.js';

class VdfSpotCheckTest {
  constructor() {
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

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

    const real = new VdfSpotCheck({
      computeCheckpoint: async ({ saltNumber, input, iterationsPerCheckpoint }) => new VdfChain({ iterationsPerCheckpoint }).computeCheckpoint(saltNumber, input),
      pickIndex: () => 7,
    });
    const started = performance.now();
    const result = await real.check(update, [difficulty], 0);
    this.report('a real server step\'s checkpoint, computed here, matches', result.checked && result.matches,
      `step ${result.stepNumber}, checkpoint ${result.index}, ${Math.round(performance.now() - started)} ms`);
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
    process.exitCode = this.failures ? 1 : 0;
  }
}

await new VdfSpotCheckTest().run();
