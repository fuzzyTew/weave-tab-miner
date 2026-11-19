// scripts/localnet-client.mjs — HTTP to a running Arweave localnet node, for the localnet
// workflow's scripts (localnet-capture.mjs, localnet-post.mjs).

export class LocalnetClient {
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

  /** POST /block2: a block in binary, announced by its id. Resolves { status, text }. */
  async postBlock(blockBinary, indepHash) {
    const response = await fetch(`${this.baseUrl}/block2`, {
      method: 'POST', body: blockBinary, signal: AbortSignal.timeout(60000),
      headers: { 'x-network': LocalnetClient.NETWORK_NAME, 'arweave-block-hash': indepHash, 'content-type': 'application/octet-stream' },
    });
    return { status: response.status, text: (await response.text()).slice(0, 300) };
  }
}
