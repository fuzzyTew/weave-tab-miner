// test/mainnet-follow.test.mjs — a captured stretch of mainnet (scripts/mainnet-capture.mjs, on the
// mainnet-fixtures branch), replayed offline: from one block's every account, follow each
// next block (its transactions and released reward must give its account root and history
// hash); before each, the transaction picker must accept all the block's transactions; and
// every replica 2.9 block is rebuilt from its solution and transactions and must come out
// with the block's own id. Prints SKIP without fixtures.
// Run: node test/mainnet-follow.test.mjs [fixtures directory]   (default: ./mainnet_fixtures)
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Bytes } from '../src/core/bytes.js';
import { FixtureAccountTree } from './fixture-account-tree.mjs';
import { ChainState } from '../src/blocks/assembler.js';
import { BlockPublisher } from '../src/blocks/block-publisher.js';
import { ChainFollower } from '../src/blocks/chain-follower.js';
import { BlockHash } from '../src/blocks/hash.js';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { RewardHistory } from '../src/blocks/rewards.js';
import { TransactionPicker } from '../src/blocks/transaction-picker.js';
import { RecordedVdfSteps, VdfInfo } from '../src/blocks/vdf-info.js';
import { TestCase } from './test-case.mjs';
import { StoredRandomx } from './file-result-store.mjs';

class MainnetFollowTest extends TestCase {
  constructor(fixturesDirectory) {
    super();
    this.fixturesDirectory = fixturesDirectory;
  }


  async startState() {
    const start = JSON.parse(readFileSync(`${this.fixturesDirectory}/start.json`, 'utf8'));
    const loaded = await FixtureAccountTree.load(`${this.fixturesDirectory}/wallet_list.json.gz`, start.block.wallet_list);
    const accountTree = loaded.tree;
    this.report(`the captured accounts hash to block ${start.block.height}'s root`, loaded.root === start.block.wallet_list, FixtureAccountTree.describe(loaded));
    return new ChainState({
      block: start.block, accountTree, recentBlocks: start.recentBlocks,
      rewardHistory: RewardHistory.fromBinary(Bytes.fromBase64Url(start.rewardHistory)),
      blockTimeHistory: BlockTimeHistory.fromBinary(Bytes.fromBase64Url(start.blockTimeHistory)),
    });
  }

  randomx() {
    return StoredRandomx.create();
  }

  /** The block rebuilt by BlockPublisher from its solution, transactions and chunks; its signature stands in. */
  async republish(follower, { block, transactions, chunks }, randomx) {
    const info = block.nonce_limiter_info;
    const twoChunks = block.recall_byte2 !== undefined && block.recall_byte2 !== null;
    const posted = [];
    const publisher = new BlockPublisher({
      follower, ...randomx, fetchChunkJson: async (offset) => chunks[String(offset)],
      signer: {
        key: { addressBytes: Bytes.fromBase64Url(block.reward_addr), address: block.reward_addr, ownerBytes: Bytes.fromBase64Url(block.reward_key) },
        sign: async (built) => {
          const signed = { ...built, signature: block.signature };
          return { ...signed, indep_hash: Bytes.toBase64Url(await BlockHash.indepHash(signed)) };
        },
      },
      nodes: [{ baseUrl: 'none', postBlock: async (binary) => { posted.push(binary); return { status: 200, text: '' }; } }],
    });
    const report = {
      stepNumber: Number(info.global_step_number),
      trace: { seed: Bytes.fromBase64Url(follower.state.block.nonce_limiter_info.seed).subarray(0, 32) },
      solution: {
        nonce: Number(Bytes.toBigInt(Bytes.fromBase64Url(block.nonce))), hash: Bytes.fromBase64Url(block.hash),
        recallByte1: BigInt(block.recall_byte), ...(twoChunks ? { recallByte2: BigInt(block.recall_byte2) } : {}),
      },
    };
    try {
      const { block: built } = await publisher.publish({ report, stepSource: RecordedVdfSteps.fromBlock(block), timestamp: block.timestamp, transactions });
      const differing = Object.keys(block).filter((field) => !['signature', 'indep_hash'].includes(field) && JSON.stringify(built[field]) !== JSON.stringify(block[field]));
      this.report(`block ${block.height} (${transactions.length} transactions) rebuilt from its solution has the block's id`, built.indep_hash === block.indep_hash && posted.length === 1,
        differing.map((field) => `${field} ${JSON.stringify(built[field])?.slice(0, 50)} vs ${JSON.stringify(block[field])?.slice(0, 50)}`).join('; '));
    } catch (error) {
      this.report(`block ${block.height} rebuilt from its solution`, false, error.message);
    }
  }

  /**
   * Reasons a pending transaction may be left out that come from the capture's gap: its
   * pending list is read a few blocks past the last captured block.
   */
  static GAP_REASONS = [/anchor/, /already in a recent block/, /has no account/, /cannot pay/, /target with no account/];

  /**
   * The newest VDF difficulty retarget height's next_vdf_difficulty, worked out from its
   * parent and the parent's block-time history: the start block's, less the entries of the
   * blocks after the parent (a history lists the newest block first). Whether the
   * difficulty actually moved there depends on the previous change having taken effect,
   * which the detail says.
   */
  checkVdfRetarget() {
    const file = `${this.fixturesDirectory}/vdf_retarget.json`;
    if (!existsSync(file)) return console.log('SKIP  VDF retarget: none was captured');
    const start = JSON.parse(readFileSync(`${this.fixturesDirectory}/start.json`, 'utf8'));
    const startHistory = BlockTimeHistory.fromBinary(Bytes.fromBase64Url(start.blockTimeHistory));
    const { parent, historyOffset, child } = JSON.parse(readFileSync(file, 'utf8'));
    const parentHistory = new BlockTimeHistory(startHistory.entries.slice(historyOffset));
    const computed = VdfInfo.nextVdfDifficulty(parent, parentHistory);
    const info = parent.nonce_limiter_info;
    const moved = String(info.vdf_difficulty) === String(info.next_vdf_difficulty);
    this.report(`block ${child.height}'s next VDF difficulty, from its parent's block-time history`, String(computed) === String(child.nonce_limiter_info.next_vdf_difficulty),
      `${moved ? 'retargeted' : 'carried over, the last change not yet in effect'}: ${info.next_vdf_difficulty} → ${computed}`);
  }

  /** Picks from the transactions pending at capture time, on the state after the last block. */
  async pickPending(state) {
    const file = `${this.fixturesDirectory}/pending.json.gz`;
    if (!existsSync(file)) return console.log('SKIP  pending transactions: none were captured');
    const pending = JSON.parse(gunzipSync(readFileSync(file)));
    const { picked, rejected } = await TransactionPicker.pick(pending, state);
    const reasons = new Map();
    for (const { reason } of rejected) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    const unexpected = rejected.filter(({ reason }) => !MainnetFollowTest.GAP_REASONS.some((pattern) => pattern.test(reason)));
    const summary = [...reasons].map(([reason, count]) => `${count} ${reason}`).join('; ');
    this.report(`of ${pending.length} pending transactions, ${picked.length} picked and the rest left out only for the capture's gap`, unexpected.length === 0, summary);
  }

  async run() {
    if (!existsSync(`${this.fixturesDirectory}/start.json`)) {
      console.log(`SKIP  no mainnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    const started = Date.now();
    const state = await this.startState();
    const captured = JSON.parse(gunzipSync(readFileSync(`${this.fixturesDirectory}/blocks.json.gz`)));
    const transactionsById = new Map(captured.flatMap(({ transactions }) => transactions.map((json) => [json.id, json])));
    const follower = new ChainFollower({ state, fetchTransaction: async (id) => transactionsById.get(id) });
    const randomx = this.randomx();
    for (const entry of captured) {
      const { block, transactions } = entry;
      if (transactions.length) {
        const { rejected } = await TransactionPicker.pick(transactions, state);
        this.report(`the picker accepts all ${transactions.length} of block ${block.height}'s transactions`, rejected.length === 0, rejected.slice(0, 3).map((item) => `${item.id.slice(0, 8)}: ${item.reason}`).join('; '));
      }
      if (block.replica_format === 1 && Object.values(entry.chunks).includes(null)) {
        console.log(`SKIP  block ${block.height}'s rebuild: no node served its chunk when it was captured`);
      } else if (block.replica_format === 1) {
        await this.republish(follower, entry, randomx);
      }
      try {
        await follower.apply(block);
        this.report(`followed block ${block.height}: its account root and history hash`, Bytes.toBase64Url(state.blockTimeHistory.hash()) === block.block_time_history_hash);
      } catch (error) {
        this.report(`followed block ${block.height}`, false, error.message);
        break;
      }
    }
    await this.pickPending(state);
    this.checkVdfRetarget();
    console.log(`(${Math.round((Date.now() - started) / 1000)} s)`);
    this.finish();
  }
}

await new MainnetFollowTest(process.argv[2] ?? 'mainnet_fixtures').run();
