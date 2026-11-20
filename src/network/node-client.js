// src/network/node-client.js — what an Arweave node serves for keeping chain state, beyond what
// gateways pass on: account lists by root, and the reward and block-time histories a block
// is built from. (From ar_http_iface_middleware.erl; gateways answered 404 for the
// histories when checked.) Nodes speak plain http on port 1984.
import { Bytes } from '../core/bytes.js';
import { ErlangAtom, ErlangTerm } from './erlang-term.js';

export class NodeClient {
  /**
   * Requests to one node. `headers` go on every request (a localnet needs X-Network).
   * Account data nodes serve, for the record: GET /wallet_list/{root}[/{cursor}] (every
   * account, in pages), /wallet_list/{root}/{address}/balance, /wallet/{address}/balance
   * and /last_tx, /block/height/{h}/wallet/{address}/balance. No per-account proofs:
   * a partial tree cannot be checked against a root with what nodes serve.
   */
  constructor(baseUrl, { headers = {}, timeoutMs = 60000 } = {}) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), headers, timeoutMs });
  }

  /**
   * fetch, tried once more when the connection was closed under it: nodes close idle
   * keep-alive connections, and fetch may reuse one after a long pause on this side and
   * fail with "other side closed".
   */
  async fetchRetryingClosed(url, options) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (error.cause?.code !== 'UND_ERR_SOCKET') throw error;
      return fetch(url, options);
    }
  }

  async get(path, readAs = 'json', extraHeaders = {}) {
    const response = await this.fetchRetryingClosed(this.baseUrl + path, { headers: { ...this.headers, ...extraHeaders }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`GET ${this.baseUrl}${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return readAs === 'bytes' ? new Uint8Array(await response.arrayBuffer()) : readAs === 'text' ? response.text() : response.json();
  }

  async height() {
    return (await this.get('/info')).height;
  }

  /**
   * Every account of a wallet-list root, page by page, in GET /wallet_list's JSON shape
   * ({ address, balance, last_tx, denomination?, mining_permission? }). Pages are read in
   * Erlang's term format (ErlangTerm), because asking for JSON takes a content-type header
   * that a browser may not send there. Each page holds up to 2,500 accounts and a
   * next_cursor until the last. `onPage(count)` reports progress.
   */
  async walletList(rootHash, { onPage = () => {} } = {}) {
    const wallets = [];
    let cursor = '';
    for (;;) {
      const page = ErlangTerm.decode(await this.get(`/wallet_list/${rootHash}${cursor ? `/${cursor}` : ''}`, 'bytes'));
      for (const entry of page.get('wallets')) wallets.push(NodeClient.walletJson(entry));
      onPage(wallets.length);
      const next = page.get('next_cursor');
      if (next instanceof ErlangAtom) return wallets; // the atom `last`
      cursor = Bytes.toBase64Url(next);
    }
  }

  /** One {Address, {Balance, LastTX[, Denomination, MiningPermission]}} as JSON would give it. */
  static walletJson(entry) {
    const [address, value] = entry.elements;
    const [balance, lastTx, denomination, miningPermission] = value.elements;
    const json = { address: Bytes.toBase64Url(address), balance: balance.toString(), last_tx: Bytes.toBase64Url(lastTx) };
    if (denomination !== undefined) Object.assign(json, { denomination: Number(denomination), mining_permission: miningPermission.name === 'true' });
    return json;
  }

  async rewardHistory(blockHash) {
    return this.get(`/reward_history/${blockHash}`, 'bytes');
  }

  async blockTimeHistory(blockHash) {
    return this.get(`/block_time_history/${blockHash}`, 'bytes');
  }

  /**
   * POST /block2: a block in binary. Sent as text/plain with no block-hash header (the
   * node reads neither): any other content type or a custom header would make a browser
   * ask CORS permission first, which nodes do not grant for /block2. Resolves
   * { status, text }.
   */
  async postBlock(blockBinary) {
    const response = await this.fetchRetryingClosed(`${this.baseUrl}/block2`, {
      method: 'POST', body: blockBinary, signal: AbortSignal.timeout(this.timeoutMs),
      headers: { ...this.headers, 'content-type': 'text/plain' },
    });
    return { status: response.status, text: (await response.text()).slice(0, 300) };
  }
}
