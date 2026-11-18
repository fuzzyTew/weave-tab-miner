// scripts/localnet-capture.mjs — saves what a block builder needs, from a running Arweave localnet:
// for each block the node mines, its parent's state and the block itself, so the builder
// can be checked offline against blocks the real node made. Run by the localnet workflow:
//   node scripts/localnet-capture.mjs <output dir> <blocks to capture>
// Mining is triggered by LOCALNET_MINE_COMMAND (a shell command), since the localnet mines
// only on request.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

class LocalnetClient {
  /**
   * Requests to a localnet node. Every request carries X-Network: arweave.localnet, or the
   * node treats it as a mainnet request and refuses it.
   */
  static NETWORK_NAME = 'arweave.localnet';

  constructor(baseUrl = 'http://127.0.0.1:1984') {
    this.baseUrl = baseUrl;
  }

  async get(path, readAs = 'json') {
    const response = await fetch(this.baseUrl + path, { headers: { 'x-network': LocalnetClient.NETWORK_NAME }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return readAs === 'bytes' ? new Uint8Array(await response.arrayBuffer()) : readAs === 'text' ? response.text() : response.json();
  }

  async height() {
    return (await this.get('/info')).height;
  }

  /**
   * Every account of a wallet-list root, page by page. Pages come as JSON only when the
   * request says content-type: application/json (otherwise Erlang's term format); each
   * holds up to 2,500 accounts and a next_cursor until the last.
   */
  async walletList(rootHash) {
    const wallets = [];
    let cursor = '';
    for (;;) {
      const response = await fetch(`${this.baseUrl}/wallet_list/${rootHash}${cursor ? `/${cursor}` : ''}`, {
        headers: { 'x-network': LocalnetClient.NETWORK_NAME, 'content-type': 'application/json' }, signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`wallet_list page after "${cursor}": HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const page = await response.json();
      wallets.push(...page.wallets);
      if (!page.next_cursor) return wallets;
      cursor = page.next_cursor;
    }
  }
}

class LocalnetCapture {
  constructor({ outputDir, blockCount, mineCommand, client = new LocalnetClient() }) {
    Object.assign(this, { outputDir, blockCount, mineCommand, client });
  }

  async waitForHeight(targetHeight, timeoutMs = 600000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((await this.client.height()) >= targetHeight) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`height ${targetHeight} not reached in ${timeoutMs / 1000} s`);
  }

  /** The parent's state a child block is computed from. */
  async parentState(parent) {
    const state = { block: parent };
    for (const [name, path] of [['rewardHistory', `/reward_history/${parent.indep_hash}`], ['blockTimeHistory', `/block_time_history/${parent.indep_hash}`]]) {
      try {
        state[name] = Buffer.from(await this.client.get(path, 'bytes')).toString('base64');
      } catch (error) {
        state[`${name}Error`] = error.message;
        console.log(`  ${name}: ${error.message}`);
      }
    }
    return state;
  }

  async run() {
    mkdirSync(this.outputDir, { recursive: true });
    const startHeight = await this.client.height();
    console.log(`localnet at height ${startHeight}`);
    const firstParent = await this.client.get(`/block/height/${startHeight}`);
    // The account tree once, at the first parent; later blocks change few accounts.
    const wallets = await this.client.walletList(firstParent.wallet_list);
    const walletBytes = gzipSync(JSON.stringify({ root: firstParent.wallet_list, height: startHeight, wallets }));
    writeFileSync(`${this.outputDir}/wallet_list_${startHeight}.json.gz`, walletBytes);
    console.log(`account tree at ${startHeight}: ${wallets.length} accounts, ${(walletBytes.length / 1e6).toFixed(1)} MB gzipped; first: ${JSON.stringify(wallets[0])}`);

    for (let index = 0; index < this.blockCount; index++) {
      const parentHeight = startHeight + index;
      const parent = await this.client.get(`/block/height/${parentHeight}`);
      const state = await this.parentState(parent);
      console.log(`mining block ${parentHeight + 1}: ${this.mineCommand}`);
      console.log(execSync(this.mineCommand, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim());
      await this.waitForHeight(parentHeight + 1);
      const child = await this.client.get(`/block/height/${parentHeight + 1}`);
      const childBinary = Buffer.from(await this.client.get(`/block2/height/${parentHeight + 1}`, 'bytes')).toString('base64');
      writeFileSync(`${this.outputDir}/block_${parentHeight + 1}.json`, `${JSON.stringify({ parent: state, child, childBinary }, null, 1)}\n`);
      console.log(`saved block ${parentHeight + 1}: ${child.indep_hash}, ${child.txs.length} txs, reward ${child.reward}`);
    }
  }
}

await new LocalnetCapture({
  outputDir: process.argv[2] ?? 'localnet_fixtures',
  blockCount: Number(process.argv[3] ?? 3),
  mineCommand: process.env.LOCALNET_MINE_COMMAND,
}).run();
