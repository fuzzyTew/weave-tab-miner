// scripts/mainnet-capture.mjs — saves a stretch of live mainnet for offline checks: one block's
// whole state (every account, its reward and block-time histories, the 50 blocks before
// it), then the next blocks with their transactions and the chunks their solutions prove,
// then the transactions pending at the end.
// test/mainnet-follow.test.mjs replays it offline in seconds; the daily workflow captures it
// and commits it to the mainnet-fixtures branch. Every request has a time limit, and the
// whole capture a deadline, so a slow network fails it with the cause instead of hanging.
// Run: node scripts/mainnet-capture.mjs [output directory]   (default: ./mainnet_fixtures)
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Bytes } from '../src/core/bytes.js';
import { ChainState } from '../src/blocks/assembler.js';
import { NodeClient } from '../src/network/node-client.js';
import { ArweaveGateway } from '../src/network/gateway.js';
import { PendingTransactionPool } from '../src/network/pending-transactions.js';

class MainnetCapture {
  static GATEWAYS = ArweaveGateway.DEFAULT_GATEWAY_URLS;
  /** Rounds through the sources before a request fails: a gateway sometimes drops one connection. */
  static ROUNDS = 2;
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
    for (let round = 0; round < MainnetCapture.ROUNDS; round++) for (const source of sources) {
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

  /**
   * GET /chunk for the chunk holding `recallByte`; failing that, the unpacked chunk the
   * block's own proof carries, if it does; failing that, null, so the replay skips this
   * block's rebuild but still follows it (chunks are sometimes served by no node at all).
   */
  async chunkFor(recallByte, poa, sources) {
    try {
      return await this.get(`/chunk/${BigInt(recallByte) + 1n}`, 'json', sources);
    } catch (error) {
      if (poa?.unpacked_chunk) {
        console.log(`${error.message.slice(0, 300)} — using the block's own proof`);
        return { chunk: poa.unpacked_chunk, data_path: poa.data_path, tx_path: poa.tx_path };
      }
      console.log(`${error.message.slice(0, 300)} — leaving it out`);
      return null;
    }
  }

  static PENDING_HEADERS = 100;
  static PENDING_ATTEMPTS = 3;

  /** One block with its transactions and the chunks a rebuild from its solution fetches again. */
  async capturedBlock(height, sources) {
    const block = await this.get(`/block/height/${height}`, 'json', sources);
    const transactions = [];
    for (const id of block.txs) transactions.push(await this.get(`/tx/${id}`, 'json', sources));
    const chunks = {};
    if (block.replica_format === 1) {
      for (const [byte, poa] of [[block.recall_byte, block.poa], [block.recall_byte2, block.poa2]]) {
        if (byte === undefined || byte === null) continue;
        chunks[String(BigInt(byte) + 1n)] = await this.chunkFor(byte, poa, sources);
      }
    }
    console.log(`block ${height}: ${transactions.length} transactions, ${Object.values(chunks).filter(Boolean).length} of ${Object.keys(chunks).length} chunks`);
    return { block, transactions, chunks };
  }

  /**
   * Transactions pending at capture time, as PendingTransactionPool fetches them: the replay
   * picks from them on the state after the last captured block.
   */
  async pendingTransactions(sources) {
    const pool = new PendingTransactionPool({ source: { get: (path) => this.get(path, 'json', sources) }, maxHeld: MainnetCapture.PENDING_HEADERS, log: console.log });
    const { pending, held, failed } = await pool.refresh();
    console.log(`${held} of ${pending} pending transactions${failed ? `, ${failed} not fetched` : ''}`);
    return pool.candidates();
  }

  async run() {
    mkdirSync(this.outputDirectory, { recursive: true });
    // Up to the tip itself: a block later orphaned by a short fork is still valid on its
    // parent, so the replay works the same, and pending transactions then match the state.
    let tip = (await this.get('/info')).height;
    const startHeight = tip - MainnetCapture.BLOCKS_AFTER;
    const start = await this.get(`/block/height/${startHeight}`);
    const { node, wallets, rewardHistory, blockTimeHistory, peers } = await this.stateFromSomeNode(start);
    const sources = [...MainnetCapture.GATEWAYS, node, ...peers.slice(0, 5)];
    const recentBlocks = await ChainState.recentBlocksFrom(start, (height) => this.get(`/block/height/${height}`));
    writeFileSync(`${this.outputDirectory}/wallet_list.json.gz`, gzipSync(JSON.stringify({ wallets })));
    writeFileSync(`${this.outputDirectory}/start.json`, JSON.stringify({
      block: start, rewardHistory: Bytes.toBase64Url(rewardHistory), blockTimeHistory: Bytes.toBase64Url(blockTimeHistory), recentBlocks,
    }));

    // Blocks up to the tip, then the pending list; if a block came meanwhile, take it too and
    // read the list again, so the list belongs to the last captured block.
    const blocks = [];
    let pending = [];
    for (let attempt = 0; attempt < MainnetCapture.PENDING_ATTEMPTS; attempt++) {
      for (let height = startHeight + 1 + blocks.length; height <= tip; height++) blocks.push(await this.capturedBlock(height, sources));
      pending = await this.pendingTransactions(sources);
      const newTip = (await this.get('/info', 'json', sources)).height;
      if (newTip === tip) break;
      console.log(`the tip moved to ${newTip} while reading pending transactions`);
      tip = newTip;
    }
    writeFileSync(`${this.outputDirectory}/pending.json.gz`, gzipSync(JSON.stringify(pending)));
    writeFileSync(`${this.outputDirectory}/blocks.json.gz`, gzipSync(JSON.stringify(blocks)));
    console.log(`captured blocks ${startHeight}–${tip} in ${Math.round((Date.now() - this.startedAt) / 1000)} s`);
  }
}

await new MainnetCapture(process.argv[2] ?? 'mainnet_fixtures').run();
