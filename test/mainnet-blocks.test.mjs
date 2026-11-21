// test/mainnet-blocks.test.mjs — the block rules a localnet relaxes, checked against recent
// mainnet blocks fetched live: difficulty retargets (every 10 heights), price adjustments
// (every 50, when a gateway serves the parent's histories), and VDF info (seeds and bounds
// across entropy reset lines, and one whole nonce_limiter_info), and following the chain
// as a light client (every account from a node, then several blocks' transactions and
// reward releases, each checked against the block's root). Needs the network, so it
// runs in CI's live-network job; it prints SKIP when no gateway answers. The quick checks run
// by default; --full adds the slow ones (a whole VDF step at mainnet difficulty, following
// the chain from every account, and rebuilding a block from its solution: minutes each).
// Run: node test/mainnet-blocks.test.mjs [--full] [gateway URL ...]
import { Bytes } from '../src/core/bytes.js';
import { DifficultyRetarget, PriceAdjustment } from '../src/blocks/adjustments.js';
import { NextBlockFields } from '../src/blocks/fields.js';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { RewardHistory } from '../src/blocks/rewards.js';
import { RecordedVdfSteps, VdfInfo } from '../src/blocks/vdf-info.js';
import { AccountTree } from '../src/blocks/account-tree.js';
import { ChainState } from '../src/blocks/assembler.js';
import { ChainFollower } from '../src/blocks/chain-follower.js';
import { NodeClient } from '../src/network/node-client.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { BlockHash } from '../src/blocks/hash.js';
import { BlockPublisher } from '../src/blocks/block-publisher.js';
import { BlockSolution } from '../src/blocks/solution.js';
import { RandomxDirectHost, RandomxH0Hasher, RandomxSquaredEntropySource } from '../src/mining/randomx.js';

class MainnetBlocksTest {
  static DEFAULT_GATEWAYS = ['https://arweave.net', 'https://ar-io.net', 'https://permagate.io'];
  static RETARGETS_CHECKED = 6;
  static ADJUSTMENTS_CHECKED = 2;
  static VDF_BLOCKS_CHECKED = 40;
  static BLOCKS_FOLLOWED = 12;

  constructor(gateways, { full = false } = {}) {
    this.full = full;
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

  async histories(parent, preferred = []) {
    const sources = [...preferred, ...await this.peers(), ...this.gateways];
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
      if (this.full && !checkedWhole && !crossed && height % VdfInfo.VDF_DIFFICULTY_RETARGET !== 0) {
        // The last step's checkpoints are computed at mainnet difficulty: tens of seconds.
        checkedWhole = true;
        const info = await VdfInfo.afterParent({ parent, parentBlockTimeHistory: new BlockTimeHistory([]), stepNumber: step, stepSource: RecordedVdfSteps.fromBlock(child) });
        this.report(`block ${height} (${step - parent.nonce_limiter_info.global_step_number} steps): whole nonce_limiter_info matches`, JSON.stringify(info) === JSON.stringify(child.nonce_limiter_info));
      }
    }
    console.log(`(${resets} of ${MainnetBlocksTest.VDF_BLOCKS_CHECKED} blocks crossed a reset line; seeds are checked on every block and reported when they cross or differ)`);
  }

  /** A node from the gateways' peer list that serves account lists. */
  async accountNode() {
    for (const url of await this.peers()) {
      const node = new NodeClient(url, { timeoutMs: 20000 });
      try {
        await node.height();
        return node;
      } catch (error) {
        console.log(`none  node ${url}: ${error.cause?.message ?? error.message}`.slice(0, 200));
      }
    }
    return null;
  }

  async follow(tip) {
    const node = await this.accountNode();
    if (!node) {
      console.log('none  no node answered, so following the chain was not tried');
      return;
    }
    const start = await this.block(tip - MainnetBlocksTest.BLOCKS_FOLLOWED);
    const started = Date.now();
    // Progress every 50 pages, so a slow or stalled node shows where it stopped.
    const accounts = await node.walletList(start.wallet_list, { onPage: (count) => { if (count % 125000 === 0) console.log(`      … ${count} accounts read from ${node.baseUrl}`); } });
    const accountTree = new AccountTree({ sha384: (bytes) => new Uint8Array(createHash('sha384').update(bytes).digest()) });
    for (const json of accounts) {
      const { addressBytes, account } = AccountTree.accountFromJson(json);
      accountTree.insert(addressBytes, account);
    }
    const root = Bytes.toBase64Url(await accountTree.rootHash());
    this.report(`${accounts.length} accounts from ${node.baseUrl} hash to block ${start.height}'s root`, root === start.wallet_list, `in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    if (root !== start.wallet_list) return;
    const histories = await this.histories(start, [node.baseUrl]);
    if (!histories) return;
    const state = new ChainState({ block: start, accountTree, rewardHistory: histories.parentRewardHistory, blockTimeHistory: histories.parentBlockTimeHistory });
    const follower = new ChainFollower({ state, fetchTransaction: (id) => this.get(`/tx/${id}`, 'json', [...this.gateways, node.baseUrl]) });
    // One block without transactions and one with them, each rebuilt from its solution.
    const republished = new Set();
    for (let height = start.height + 1; height <= tip; height++) {
      const block = await this.block(height);
      const kind = block.txs.length ? 'with transactions' : 'empty';
      if (!republished.has(kind) && block.replica_format === 1) {
        republished.add(kind);
        await this.republish(follower, block, await Promise.all(block.txs.map((id) => this.get(`/tx/${id}`, 'json', [...this.gateways, node.baseUrl]))));
      }
      try {
        const { transactionCount } = await follower.apply(block);
        const historiesMatch = Bytes.toBase64Url(state.blockTimeHistory.hash()) === block.block_time_history_hash;
        this.report(`followed block ${height} (${transactionCount} transactions): our root and block-time history hash are the block's`, historiesMatch);
      } catch (error) {
        this.report(`followed block ${height}`, false, error.message);
        return;
      }
    }
  }

  /**
   * BlockPublisher rebuilding a real mainnet block from its solution and its transactions:
   * chunks fetched from gateways and packed here with real RandomX,
   * the block assembled on the followed state, and its id compared with the block's,
   * with the block's own signature standing in for signing.
   */
  async republish(follower, block, transactions) {
    if (!this.randomx) {
      runInThisContext(readFileSync(new URL('../vendor/randomx-arweave/randomx-arweave.iife.js', import.meta.url), 'utf8') + '\nglobalThis.RandomxArweave = RandomxArweave;');
      const host = new RandomxDirectHost(globalThis.RandomxArweave);
      this.randomx = { h0Hasher: new RandomxH0Hasher(host), entropySource: new RandomxSquaredEntropySource(host) };
    }
    const twoChunks = block.recall_byte2 !== undefined && block.recall_byte2 !== null;
    const info = block.nonce_limiter_info;
    const report = {
      stepNumber: Number(info.global_step_number),
      trace: { seed: Bytes.fromBase64Url(follower.state.block.nonce_limiter_info.seed).subarray(0, 32) },
      solution: {
        nonce: Number(Bytes.toBigInt(Bytes.fromBase64Url(block.nonce))), hash: Bytes.fromBase64Url(block.hash),
        recallByte1: BigInt(block.recall_byte), ...(twoChunks ? { recallByte2: BigInt(block.recall_byte2) } : {}),
      },
    };
    const posted = [];
    const publisher = new BlockPublisher({
      follower, ...this.randomx, fetchChunkJson: (offset) => this.get(`/chunk/${offset}`),
      signer: {
        wallet: { addressBytes: Bytes.fromBase64Url(block.reward_addr), address: block.reward_addr, ownerBytes: Bytes.fromBase64Url(block.reward_key) },
        sign: async (built) => {
          const signed = { ...built, signature: block.signature };
          return { ...signed, indep_hash: Bytes.toBase64Url(await BlockHash.indepHash(signed)) };
        },
      },
      nodes: [{ baseUrl: 'none', postBlock: async (binary) => { posted.push(binary); return { status: 200, text: '' }; } }],
    });
    const checkpoints = new Map([[report.stepNumber, info.last_step_checkpoints.map(Bytes.fromBase64Url).reverse()]]);
    try {
      const started = Date.now();
      const { block: built } = await publisher.publish({ report, stepSource: new RecordedVdfSteps(RecordedVdfSteps.fromBlock(block).outputsByStep, undefined, checkpoints), timestamp: block.timestamp, transactions });
      const differing = Object.keys(block).filter((field) => !['signature', 'indep_hash'].includes(field) && JSON.stringify(built[field]) !== JSON.stringify(block[field]));
      this.report(`republished mainnet block ${block.height} (${transactions.length} transactions) from its solution and transactions: the same id (${((Date.now() - started) / 1000).toFixed(0)} s)`, built.indep_hash === block.indep_hash && posted.length === 1,
        differing.length ? `differ: ${differing.map((field) => `${field} ${JSON.stringify(built[field])?.slice(0, 60)} vs ${JSON.stringify(block[field])?.slice(0, 60)}`).join('; ')}` : '');
    } catch (error) {
      // Say which part differs: the unpacked chunk, its packing, or H0 and the hash.
      let diagnosis = '';
      try {
        const fields = await BlockSolution.build({
          addressBytes: Bytes.fromBase64Url(block.reward_addr), vdfInfo: info, seed: Bytes.fromBase64Url(follower.state.block.nonce_limiter_info.seed), nonce: report.solution.nonce,
          recallByte: report.solution.recallByte1, chunkJson: await this.get(`/chunk/${report.solution.recallByte1 + 1n}`),
          ...(twoChunks ? { recallByte2: report.solution.recallByte2, chunk2Json: await this.get(`/chunk/${report.solution.recallByte2 + 1n}`) } : {}),
          ...this.randomx,
        });
        const compared = ['unpacked_chunk_hash', 'chunk_hash', 'unpacked_chunk2_hash', 'chunk2_hash', 'hash', 'partition_number', 'packing_difficulty', 'replica_format'];
        diagnosis = compared.map((field) => `${field} ${JSON.stringify(fields[field]) === JSON.stringify(block[field]) ? 'same' : `ours ${fields[field]} vs ${block[field]}`}`).join('; ');
      } catch (diagnosisError) {
        diagnosis = `(diagnosis failed: ${diagnosisError.message})`;
      }
      this.report(`republished mainnet block ${block.height} from its solution`, false, `${error.message} — ${diagnosis}`);
    }
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
    for (const section of this.full ? ['vdf', 'follow'] : ['retargets', 'adjustments', 'vdf']) {
      try {
        await this[section](tip);
      } catch (error) {
        this.report(`${section}: ran to the end`, false, error.stack);
      }
    }
    process.exitCode = this.failures ? 1 : 0;
  }
}

const flags = process.argv.slice(2);
await new MainnetBlocksTest(flags.filter((flag) => !flag.startsWith('--')), { full: flags.includes('--full') }).run();
