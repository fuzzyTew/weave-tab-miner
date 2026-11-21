// scripts/mainnet-capture.mjs — saves a stretch of live mainnet for offline checks: one block's
// whole state (every account, its reward and block-time histories, the 50 blocks before
// it), then the next blocks with their transactions and the chunks their solutions prove.
// test/mainnet-follow.test.mjs replays it offline in seconds; the daily workflow captures it
// and commits it to the mainnet-fixtures branch. Every request has a time limit, and the
// whole capture a deadline, so a slow network fails it with the cause instead of hanging.
// Run: node scripts/mainnet-capture.mjs [output directory]   (default: ./mainnet_fixtures)
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Bytes } from '../src/core/bytes.js';
import { ChainState } from '../src/blocks/assembler.js';
import { NodeClient } from '../src/network/node-client.js';

class MainnetCapture {
  static GATEWAYS = ['https://arweave.net', 'https://ar-io.net', 'https://permagate.io'];
  static BLOCKS_AFTER = 8;
  static DEADLINE_MS = 15 * 60_000;
  static REQUEST_TIMEOUT_MS = 30_000;

  constructor(outputDirectory) {
    this.outputDirectory = outputDirectory;
    this.startedAt = Date.now();
  }

  /** JSON or bytes for `path` from the first of `sources` that answers; throws with every one's reason. */
  async get(path, readAs = 'json', sources = MainnetCapture.GATEWAYS) {
    if (Date.now() - this.startedAt > MainnetCapture.DEADLINE_MS) throw new Error(`capture deadline of ${MainnetCapture.DEADLINE_MS / 60000} minutes passed`);
    const reasons = [];
    for (const source of sources) {
      try {
        const response = await fetch(source + path, { signal: AbortSignal.timeout(MainnetCapture.REQUEST_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return readAs === 'bytes' ? new Uint8Array(await response.arrayBuffer()) : await response.json();
      } catch (error) {
        reasons.push(`${source}: ${error.cause?.message ?? error.message}`);
      }
    }
    throw new Error(`${path}: ${reasons.join('; ')}`);
  }

  /** A node from the gateways' peer list serving the start block's accounts and histories. */
  async stateFromSomeNode(start) {
    const peers = (await this.get('/peers')).slice(0, 20).map((peer) => `http://${peer}`);
    for (const url of peers) {
      const node = new NodeClient(url, { timeoutMs: MainnetCapture.REQUEST_TIMEOUT_MS });
      try {
        const wallets = await node.walletList(start.wallet_list);
        const rewardHistory = await node.rewardHistory(start.indep_hash);
        const blockTimeHistory = await node.blockTimeHistory(start.indep_hash);
        console.log(`${wallets.length} accounts and both histories from ${url}`);
        return { node: url, wallets, rewardHistory, blockTimeHistory, peers };
      } catch (error) {
        console.log(`${url}: ${error.cause?.message ?? error.message}`.slice(0, 200));
      }
    }
    throw new Error('no peer served the accounts and histories');
  }

  async run() {
    mkdirSync(this.outputDirectory, { recursive: true });
    const tip = (await this.get('/info')).height - 5; // a few blocks back, past short forks
    const startHeight = tip - MainnetCapture.BLOCKS_AFTER;
    const start = await this.get(`/block/height/${startHeight}`);
    const { node, wallets, rewardHistory, blockTimeHistory, peers } = await this.stateFromSomeNode(start);
    const sources = [...MainnetCapture.GATEWAYS, node, ...peers.slice(0, 5)];
    const recentBlocks = await ChainState.recentBlocksFrom(start, (height) => this.get(`/block/height/${height}`));
    writeFileSync(`${this.outputDirectory}/wallet_list.json.gz`, gzipSync(JSON.stringify({ wallets })));
    writeFileSync(`${this.outputDirectory}/start.json`, JSON.stringify({
      block: start, rewardHistory: Bytes.toBase64Url(rewardHistory), blockTimeHistory: Bytes.toBase64Url(blockTimeHistory), recentBlocks,
    }));

    const blocks = [];
    for (let height = startHeight + 1; height <= tip; height++) {
      const block = await this.get(`/block/height/${height}`);
      const transactions = [];
      for (const id of block.txs) transactions.push(await this.get(`/tx/${id}`, 'json', sources));
      // The chunks a rebuild from the solution fetches again (replica 2.9 blocks only).
      const chunks = {};
      if (block.replica_format === 1) {
        for (const byte of [block.recall_byte, block.recall_byte2].filter((value) => value !== undefined && value !== null)) {
          const offset = String(BigInt(byte) + 1n);
          chunks[offset] = await this.get(`/chunk/${offset}`, 'json', sources);
        }
      }
      blocks.push({ block, transactions, chunks });
      console.log(`block ${height}: ${transactions.length} transactions, ${Object.keys(chunks).length} chunks`);
    }
    writeFileSync(`${this.outputDirectory}/blocks.json.gz`, gzipSync(JSON.stringify(blocks)));
    console.log(`captured blocks ${startHeight}–${tip} in ${Math.round((Date.now() - this.startedAt) / 1000)} s`);
  }
}

await new MainnetCapture(process.argv[2] ?? 'mainnet_fixtures').run();
