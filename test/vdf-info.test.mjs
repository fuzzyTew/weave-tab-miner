// test/vdf-info.test.mjs — VdfInfo.afterParent against the saved localnet blocks: from each
// block's parent, rebuild the block's whole nonce_limiter_info and require it to equal the
// node's. Steps come from the block's own lists (RecordedVdfSteps), so this checks the
// lists, seeds and bounds; one checkpoint of a block's own step is computed for real (a
// third of a second; the whole step is 8 s), to check the localnet's VDF difficulty and the
// step's salt. Also the entropy reset points, as in ar_nonce_limiter's tests.
// Run: node test/vdf-info.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { Bytes } from '../src/core/bytes.js';
import { ConsensusConstants } from '../src/core/constants.js';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { RecordedVdfSteps, VdfInfo } from '../src/blocks/vdf-info.js';
import { VdfChain } from '../src/mining/vdf.js';

class VdfInfoTest {
  constructor(fixturesDirectory) {
    this.fixturesDirectory = fixturesDirectory;
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  resetPoints() {
    // ar_nonce_limiter:get_entropy_reset_point_test/0.
    const frequency = ConsensusConstants.NONCE_LIMITER_RESET_FREQUENCY;
    const cases = [[1, frequency - 1, null], [1, frequency, frequency], [frequency, frequency + 1, null],
      [frequency, frequency * 2, 2 * frequency], [frequency * 3 - 1, frequency * 3 + 2, frequency * 3], [frequency * 3, frequency * 4 + 1, frequency * 4]];
    const wrong = cases.filter(([previous, step, expected]) => VdfInfo.resetPoint(previous, step) !== expected);
    this.report('entropy reset points match ar_nonce_limiter\'s tests', wrong.length === 0, wrong.map(String).join('; '));
  }

  /**
   * The first checkpoint of the block's step, from the parent-side step before it, as
   * VdfChain.computeStep starts it. Skipped on a reset step, whose input mixes in a seed.
   */
  firstCheckpoint(child) {
    const info = child.nonce_limiter_info;
    const stepNumber = Number(info.global_step_number);
    if (VdfChain.isResetStep(stepNumber)) return;
    const started = performance.now();
    const chain = new VdfChain({ iterationsPerCheckpoint: Number(info.vdf_difficulty) });
    const computed = chain.computeCheckpoint(VdfChain.saltNumberForStep(stepNumber - 1), Bytes.fromBase64Url(info.checkpoints[1]));
    const expected = info.last_step_checkpoints.at(-1);
    this.report(`block ${child.height}: its step's first checkpoint, computed, matches the node's`, Bytes.toBase64Url(computed) === expected, `${Math.round(performance.now() - started)} ms`);
  }

  /**
   * A block built on a block this library built: one step past it lists one step, and its
   * prev_output is that block's output (what a node checks first). Steps come from a stand-in
   * source, since only the chaining is checked here.
   */
  async chainedOnOwnBlock(parent, blockTimeHistory) {
    const stepSource = {
      output: async ({ stepNumber }) => new Uint8Array(32).fill(stepNumber % 251),
      checkpoints: async ({ stepNumber }) => Array.from({ length: 25 }, (_, index) => new Uint8Array(32).fill((stepNumber + index) % 251)),
    };
    const parentStep = Number(parent.nonce_limiter_info.global_step_number);
    const own = { ...parent, height: Number(parent.height) + 1, nonce_limiter_info: await VdfInfo.afterParent({ parent, parentBlockTimeHistory: blockTimeHistory, stepNumber: parentStep + 3, stepSource }) };
    const next = await VdfInfo.afterParent({ parent: own, parentBlockTimeHistory: blockTimeHistory, stepNumber: parentStep + 4, stepSource });
    this.report('a block one step past one built here lists one step, after that block\'s output',
      own.nonce_limiter_info.checkpoints.length === 3 && next.checkpoints.length === 1 && next.prev_output === own.nonce_limiter_info.output && next.global_step_number === parentStep + 4);
  }

  async run() {
    this.resetPoints();
    if (!existsSync(this.fixturesDirectory)) {
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    let checkpointChecked = false;
    let chainChecked = false;
    for (const name of readdirSync(this.fixturesDirectory).filter((file) => file.startsWith('block_')).sort()) {
      const { parent, child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      if (!chainChecked) {
        await this.chainedOnOwnBlock(parent.block, BlockTimeHistory.fromBinary(Bytes.fromBase64Url(parent.blockTimeHistory)));
        chainChecked = true;
      }
      const info = await VdfInfo.afterParent({
        parent: parent.block,
        parentBlockTimeHistory: BlockTimeHistory.fromBinary(Bytes.fromBase64Url(parent.blockTimeHistory)),
        stepNumber: Number(child.nonce_limiter_info.global_step_number),
        stepSource: RecordedVdfSteps.fromBlock(child),
      });
      if (!checkpointChecked && child.nonce_limiter_info.checkpoints.length > 1) {
        this.firstCheckpoint(child);
        checkpointChecked = true;
      }
      const expected = child.nonce_limiter_info;
      const differing = [...new Set([...Object.keys(info), ...Object.keys(expected)])].filter((field) => JSON.stringify(info[field]) !== JSON.stringify(expected[field]));
      const steps = expected.global_step_number - parent.block.nonce_limiter_info.global_step_number;
      this.report(`block ${child.height} (${steps} steps after its parent): nonce_limiter_info matches the node's`, differing.length === 0 && JSON.stringify(info) === JSON.stringify(expected), differing.length ? `differ: ${differing.join(', ')}` : '');
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

await new VdfInfoTest(process.argv[2] ?? 'localnet_fixtures').run();
