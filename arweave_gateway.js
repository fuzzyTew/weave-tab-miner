// arweave_gateway.js — HTTP access to Arweave through public gateways, shared by the miner,
// the wallet lookups and transaction submission. Works in browsers and in Node 18+.

export class ArweaveGateway {
  /**
   * Talks to gateways over HTTPS, trying each in turn. Every failure is kept with its
   * cause, so a network that blocks gateways shows up plainly instead of as a hang.
   */
  constructor({ gatewayUrls = ['https://arweave.net', 'https://ar-io.net', 'https://permagate.io'], timeoutMs = 20000, log = () => {} } = {}) {
    this.gatewayUrls = gatewayUrls;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  async request(path, { method = 'GET', body = undefined, headers = {}, readAs = 'json', firstGatewayOnly = false } = {}) {
    const failures = [];
    const gatewayUrls = firstGatewayOnly ? this.gatewayUrls.slice(0, 1) : this.gatewayUrls;
    for (const gatewayUrl of gatewayUrls) {
      const url = gatewayUrl + path;
      try {
        const response = await fetch(url, { method, body, headers, signal: AbortSignal.timeout(this.timeoutMs) });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
        return readAs === 'json' ? JSON.parse(text) : text;
      } catch (error) {
        const reason = `${method} ${url}: ${error.name}: ${error.message}`;
        failures.push(reason);
        this.log(`request failed — ${reason}`);
      }
    }
    throw new Error(`no gateway succeeded for ${method} ${path}:\n${failures.join('\n')}`);
  }

  // ---- chain and data ----

  async currentBlock() {
    return this.request('/block/current');
  }

  /** The unpacked chunk covering a weave byte, as raw base64url text plus proofs. */
  async chunkJson(weaveByte) {
    return this.request(`/chunk/${weaveByte.toString()}`);
  }

  // ---- wallets ----

  /** Spendable balance in winston (1 AR = 10^12 winston), as a BigInt. */
  async balanceWinston(address) {
    return BigInt((await this.request(`/wallet/${address}/balance`, { readAs: 'text' })).trim());
  }

  /** Mining rewards earned but still locked by the protocol, in winston. */
  async reservedRewardsWinston(address) {
    return BigInt((await this.request(`/wallet/${address}/reserved_rewards_total`, { readAs: 'text' })).trim());
  }

  /**
   * Recent transactions sent from and to an address, via the gateway's GraphQL index.
   * Mining rewards are not transactions, so they show only in the balance.
   */
  async transactionHistory(address, count = 10) {
    const fields = 'edges { node { id recipient quantity { ar } fee { ar } data { size } block { height timestamp } tags { name value } } }';
    const query = `query ($addresses: [String!]) {
      sent: transactions(owners: $addresses, first: ${count}, sort: HEIGHT_DESC) { ${fields} }
      received: transactions(recipients: $addresses, first: ${count}, sort: HEIGHT_DESC) { ${fields} }
    }`;
    const reply = await this.request('/graphql', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { addresses: [address] } }),
    });
    if (reply.errors) throw new Error(`GraphQL: ${JSON.stringify(reply.errors).slice(0, 300)}`);
    const nodes = (connection) => connection.edges.map((edge) => edge.node);
    return { sent: nodes(reply.data.sent), received: nodes(reply.data.received) };
  }

  // ---- transactions ----

  /** A recent block or transaction id that new transactions must reference. */
  async transactionAnchor() {
    return (await this.request('/tx_anchor', { readAs: 'text' })).trim();
  }

  /** The network's fee for storing `byteCount` bytes, in winston. */
  async priceWinston(byteCount) {
    return BigInt((await this.request(`/price/${byteCount}`, { readAs: 'text' })).trim());
  }

  /**
   * Post a signed transaction. Sent to the first gateway only: the transaction is
   * identical everywhere, and one accepted copy spreads through the network.
   */
  async postTransaction(transactionJson) {
    return this.request('/tx', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(transactionJson), readAs: 'text', firstGatewayOnly: true,
    });
  }

  async transactionStatus(transactionId) {
    return this.request(`/tx/${transactionId}/status`, { readAs: 'text' });
  }
}
