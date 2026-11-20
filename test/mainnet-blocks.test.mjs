// test/mainnet-blocks.test.mjs — the block rules a localnet relaxes, checked against recent
// mainnet blocks fetched live: difficulty retargets (every 10 heights), price adjustments
// (every 50, when a gateway serves the parent's histories), and VDF info (seeds and bounds
// across entropy reset lines, and one whole nonce_limiter_info). Needs the network, so it
// runs in CI's live-network job; it prints SKIP when no gateway answers.
// Run: node test/mainnet-blocks.test.mjs [gateway URL ...]
import { Bytes } from '../src/core/bytes.js';
import { DifficultyRetarget, PriceAdjustment } from '../src/blocks/adjustments.js';
import { NextBlockFields } from '../src/blocks/fields.js';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { RewardHistory } from '../src/blocks/rewards.js';
import { RecordedVdfSteps, VdfInfo } from '../src/blocks/vdf-info.js';

class MainnetBlocksTest {
  static DEFAULT_GATEWAYS = ['https://arweave.net', 'https://ar-io.net', 'https://permagate.io'];
  static RETARGETS_CHECKED = 6;
  static ADJUSTMENTS_CHECKED = 2;
  static VDF_BLOCKS_CHECKED = 40;

  constructor(gateways) {
    this.gateways = gateways.length ? gateways : MainnetBlocksTest.DEFAULT_GATEWAYS;
    this.failures = 0;
    this.blocks = new Map();
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  /**
   * The first answer for `path` from `sources` (default: the gateways), as JSON or bytes,
   * each source tried twice since the network is flaky; throws with every source's error.
   */
  async get(path, readAs = 'json', sources = this.gateways) {
    const errors = [];
    for (const source of sources) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(source + path, { signal: AbortSignal.timeout(60000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return readAs === 'bytes' ? new Uint8Array(await response.arrayBuffer()) : await response.json();
        } catch (error) {
          if (attempt === 1 || error.message.startsWith('HTTP')) {
            errors.push(`${source}: ${error.cause?.message ?? error.message}`);
            break;
          }
        }
      }
    }
    throw new Error(`${path}: ${errors.join('; ')}`);
  }

  /** Nodes from a gateway's /peers: they serve the histories gateways do not. */
  async peers() {
    if (!this.peerList) {
      try {
        this.peerList = (await this.get('/peers')).slice(0, 15).map((peer) => `http://${peer}`);
      } catch (error) {
        console.log(`none  peers: ${error.message.slice(0, 200)}`);
        this.peerList = [];
      }
    }
    return this.peerList;
  }

  async block(height) {
    if (!this.blocks.has(height)) this.blocks.set(height, await this.get(`/block/height/${height}`));
    return this.blocks.get(height);
  }

  async histories(parent) {
    const sources = [...this.gateways, ...await this.peers()];
    try {
      return {
        parentRewardHistory: RewardHistory.fromBinary(await this.get(`/reward_history/${parent.indep_hash}`, 'bytes', sources)),
        parentBlockTimeHistory: BlockTimeHistory.fromBinary(await this.get(`/block_time_history/${parent.indep_hash}`, 'bytes', sources)),
      };
    } catch (error) {
      console.log(`none  histories of block ${parent.height}: ${error.message.slice(0, 300)}`);
      return null;
    }
  }

  async retargets(tip) {
    let height = tip - (tip % DifficultyRetarget.RETARGET_BLOCKS);
    for (let checked = 0; checked < MainnetBlocksTest.RETARGETS_CHECKED; checked++, height -= DifficultyRetarget.RETARGET_BLOCKS) {
      const [parent, child] = [await this.block(height - 1), await this.block(height)];
      const fields = DifficultyRetarget.fields({ height, parent, timestamp: child.timestamp });
      const changed = fields.diff !== parent.diff ? 'difficulty changed' : 'difficulty kept';
      this.report(`retarget at ${height} (${changed}): diff and last_retarget match`, fields.diff === child.diff && fields.last_retarget === child.last_retarget,
        `ours ${fields.diff} / ${fields.last_retarget}, the block's ${child.diff} / ${child.last_retarget}`);
    }
  }

  async adjustments(tip) {
    let height = tip - (tip % PriceAdjustment.PRICE_ADJUSTMENT_FREQUENCY);
    for (let checked = 0; checked < MainnetBlocksTest.ADJUSTMENTS_CHECKED; checked++, height -= PriceAdjustment.PRICE_ADJUSTMENT_FREQUENCY) {
      const [parent, child] = [await this.block(height - 1), await this.block(height)];
      const histories = await this.histories(parent);
      if (!histories) continue;
      const fields = NextBlockFields.compute({ parent, ...histories, timestamp: child.timestamp });
      const differing = Object.entries(fields).filter(([field, value]) => field !== 'txs' && field !== 'tx_root' && field !== 'block_size' && field !== 'weave_size' && field !== 'reward' && field !== 'reward_pool' && JSON.stringify(value) !== JSON.stringify(child[field]));
      // Mainnet blocks carry transactions, whose fees and data the empty-block fields leave out.
      this.report(`price adjustment at ${height}: prices, rates and the other fields that ignore transactions match`, differing.length === 0,
        differing.map(([field, value]) => `${field} ${JSON.stringify(value)} vs ${JSON.stringify(child[field])}`).join('; '));
    }
  }

  async vdf(tip) {
    let resets = 0;
    let checkedWhole = false;
    for (let height = tip - MainnetBlocksTest.VDF_BLOCKS_CHECKED; height <= tip; height++) {
      let parent;
      let child;
      try {
        [parent, child] = [await this.block(height - 1), await this.block(height)];
      } catch (error) {
        console.log(`none  block ${height}: ${error.message.slice(0, 200)}`);
        continue;
      }
      const step = Number(child.nonce_limiter_info.global_step_number);
      const crossed = VdfInfo.resetPoint(Number(parent.nonce_limiter_info.global_step_number), step) !== null;
      if (crossed) resets++;
      const seedData = VdfInfo.seedData(parent, step);
      const differing = Object.entries(seedData).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(child.nonce_limiter_info[field]));
      if (crossed || differing.length) {
        this.report(`block ${height}${crossed ? ' (crosses a reset line)' : ''}: seeds, bounds and VDF difficulty match`, differing.length === 0,
          differing.map(([field, value]) => `${field} ${JSON.stringify(value)} vs ${JSON.stringify(child.nonce_limiter_info[field])}`).join('; '));
      }
      if (!checkedWhole && !crossed && height % VdfInfo.VDF_DIFFICULTY_RETARGET !== 0) {
        // The last step's checkpoints are computed at mainnet difficulty: tens of seconds.
        checkedWhole = true;
        const info = await VdfInfo.afterParent({ parent, parentBlockTimeHistory: new BlockTimeHistory([]), stepNumber: step, stepSource: RecordedVdfSteps.fromBlock(child) });
        this.report(`block ${height} (${step - parent.nonce_limiter_info.global_step_number} steps): whole nonce_limiter_info matches`, JSON.stringify(info) === JSON.stringify(child.nonce_limiter_info));
      }
    }
    console.log(`(${resets} of ${MainnetBlocksTest.VDF_BLOCKS_CHECKED} blocks crossed a reset line; seeds are checked on every block and reported when they cross or differ)`);
  }

  async run() {
    let tip;
    try {
      tip = (await this.get('/info')).height - 5; // a few blocks back, past short forks
    } catch (error) {
      console.log(`SKIP  no gateway answered: ${error.message}`);
      return;
    }
    console.log(`checking mainnet blocks below ${tip}`);
    for (const section of ['retargets', 'adjustments', 'vdf']) {
      try {
        await this[section](tip);
      } catch (error) {
        this.report(`${section}: ran to the end`, false, error.stack);
      }
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

await new MainnetBlocksTest(process.argv.slice(2)).run();
