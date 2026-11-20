// test/vdf-info.test.mjs — VdfInfo.afterParent against the saved localnet blocks: from each
// block's parent, rebuild the block's whole nonce_limiter_info and require it to equal the
// node's. Earlier steps' outputs are taken from the block's own list (RecordedVdfSteps), so
// this checks the list, seeds and bounds; the final step's 25 checkpoints are computed for
// real (about 8 s a block). Also the entropy reset points, as in ar_nonce_limiter's tests.
// Run: node test/vdf-info.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { Bytes } from '../src/core/bytes.js';
import { ConsensusConstants } from '../src/core/constants.js';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { RecordedVdfSteps, VdfInfo } from '../src/blocks/vdf-info.js';

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

  async run() {
    this.resetPoints();
    if (!existsSync(this.fixturesDirectory)) {
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    for (const name of readdirSync(this.fixturesDirectory).filter((file) => file.startsWith('block_')).sort()) {
      const { parent, child } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const info = await VdfInfo.afterParent({
        parent: parent.block,
        parentBlockTimeHistory: BlockTimeHistory.fromBinary(Bytes.fromBase64Url(parent.blockTimeHistory)),
        stepNumber: Number(child.nonce_limiter_info.global_step_number),
        stepSource: RecordedVdfSteps.fromBlock(child),
      });
      const expected = child.nonce_limiter_info;
      const differing = [...new Set([...Object.keys(info), ...Object.keys(expected)])].filter((field) => JSON.stringify(info[field]) !== JSON.stringify(expected[field]));
      const steps = expected.global_step_number - parent.block.nonce_limiter_info.global_step_number;
      this.report(`block ${child.height} (${steps} steps after its parent): nonce_limiter_info matches the node's`, differing.length === 0 && JSON.stringify(info) === JSON.stringify(expected), differing.length ? `differ: ${differing.join(', ')}` : '');
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

await new VdfInfoTest(process.argv[2] ?? 'localnet_fixtures').run();
