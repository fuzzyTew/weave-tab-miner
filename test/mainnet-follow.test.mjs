// test/mainnet-follow.test.mjs — a captured stretch of mainnet (scripts/mainnet-capture.mjs, on the
// mainnet-fixtures branch), replayed offline: from one block's every account, follow each
// next block (its transactions and released reward must give its account root and history
// hash); before each, the transaction picker must accept all the block's transactions; and
// every replica 2.9 block is rebuilt from its solution and transactions and must come out
// with the block's own id. Prints SKIP without fixtures.
// Run: node test/mainnet-follow.test.mjs [fixtures directory]   (default: ./mainnet_fixtures)
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { runInThisContext } from 'node:vm';
import { Bytes } from '../src/core/bytes.js';
import { AccountTree } from '../src/blocks/account-tree.js';
import { ChainState } from '../src/blocks/assembler.js';
import { BlockPublisher } from '../src/blocks/block-publisher.js';
import { ChainFollower } from '../src/blocks/chain-follower.js';
import { BlockHash } from '../src/blocks/hash.js';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { RewardHistory } from '../src/blocks/rewards.js';
import { TransactionPicker } from '../src/blocks/transaction-picker.js';
import { RecordedVdfSteps } from '../src/blocks/vdf-info.js';
import { RandomxDirectHost, RandomxH0Hasher, RandomxSquaredEntropySource } from '../src/mining/randomx.js';

class MainnetFollowTest {
  constructor(fixturesDirectory) {
    this.fixturesDirectory = fixturesDirectory;
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  async startState() {
    const start = JSON.parse(readFileSync(`${this.fixturesDirectory}/start.json`, 'utf8'));
    const { wallets } = JSON.parse(gunzipSync(readFileSync(`${this.fixturesDirectory}/wallet_list.json.gz`)));
    // Node's own SHA-384 is about three times faster than the library's, for 300,000 accounts.
    const accountTree = new AccountTree({ sha384: (bytes) => new Uint8Array(createHash('sha384').update(bytes).digest()) });
    for (const json of wallets) {
      const { addressBytes, account } = AccountTree.accountFromJson(json);
      accountTree.insert(addressBytes, account);
    }
    const root = Bytes.toBase64Url(await accountTree.rootHash());
    this.report(`${wallets.length} captured accounts hash to block ${start.block.height}'s root`, root === start.block.wallet_list);
    return new ChainState({
      block: start.block, accountTree, recentBlocks: start.recentBlocks,
      rewardHistory: RewardHistory.fromBinary(Bytes.fromBase64Url(start.rewardHistory)),
      blockTimeHistory: BlockTimeHistory.fromBinary(Bytes.fromBase64Url(start.blockTimeHistory)),
    });
  }

  randomx() {
    runInThisContext(readFileSync(new URL('../vendor/randomx-arweave/randomx-arweave.iife.js', import.meta.url), 'utf8') + '\nglobalThis.RandomxArweave = RandomxArweave;');
    const host = new RandomxDirectHost(globalThis.RandomxArweave);
    return { h0Hasher: new RandomxH0Hasher(host), entropySource: new RandomxSquaredEntropySource(host) };
  }

  /** The block rebuilt by BlockPublisher from its solution, transactions and chunks; its signature stands in. */
  async republish(follower, { block, transactions, chunks }, randomx) {
    const info = block.nonce_limiter_info;
    const twoChunks = block.recall_byte2 !== undefined && block.recall_byte2 !== null;
    const posted = [];
    const publisher = new BlockPublisher({
      follower, ...randomx, fetchChunkJson: async (offset) => chunks[String(offset)],
      signer: {
        wallet: { addressBytes: Bytes.fromBase64Url(block.reward_addr), address: block.reward_addr, ownerBytes: Bytes.fromBase64Url(block.reward_key) },
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
    // The block's own steps and last-step checkpoints, so no step is computed again here.
    const checkpoints = new Map([[report.stepNumber, info.last_step_checkpoints.map(Bytes.fromBase64Url).reverse()]]);
    try {
      const { block: built } = await publisher.publish({ report, stepSource: new RecordedVdfSteps(RecordedVdfSteps.fromBlock(block).outputsByStep, undefined, checkpoints), timestamp: block.timestamp, transactions });
      const differing = Object.keys(block).filter((field) => !['signature', 'indep_hash'].includes(field) && JSON.stringify(built[field]) !== JSON.stringify(block[field]));
      this.report(`block ${block.height} (${transactions.length} transactions) rebuilt from its solution has the block's id`, built.indep_hash === block.indep_hash && posted.length === 1,
        differing.map((field) => `${field} ${JSON.stringify(built[field])?.slice(0, 50)} vs ${JSON.stringify(block[field])?.slice(0, 50)}`).join('; '));
    } catch (error) {
      this.report(`block ${block.height} rebuilt from its solution`, false, error.message);
    }
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
      if (block.replica_format === 1) await this.republish(follower, entry, randomx);
      try {
        await follower.apply(block);
        this.report(`followed block ${block.height}: its account root and history hash`, Bytes.toBase64Url(state.blockTimeHistory.hash()) === block.block_time_history_hash);
      } catch (error) {
        this.report(`followed block ${block.height}`, false, error.message);
        break;
      }
    }
    console.log(`(${Math.round((Date.now() - started) / 1000)} s)`);
    process.exitCode = this.failures ? 1 : 0;
  }
}

await new MainnetFollowTest(process.argv[2] ?? 'mainnet_fixtures').run();
