// src/network/gateway.js — HTTP access to Arweave through public gateways, shared by the miner,
// the wallet lookups and transaction submission. Works in browsers and in Node 18+.

export class ArweaveGateway {
  /**
   * Talks to gateways over HTTPS, trying each in turn. Every failure is kept with its
   * cause, so a network that blocks gateways shows up plainly instead of as a hang.
   */
  // ar-io.net and permagate.io were in this list until the live check found neither answering.
  static DEFAULT_GATEWAY_URLS = ['https://arweave.net', 'https://turbo-gateway.com'];

  constructor({ gatewayUrls = ArweaveGateway.DEFAULT_GATEWAY_URLS, timeoutMs = 20000, log = () => {} } = {}) {
    // Sources are tried in three tiers: chosen first (a person's seeds, or tested sources
    // fastest first), then directly reachable nodes, then gateways.
    this.firstUrls = [];
    this.peerUrls = [];
    // Addresses known to be Arweave nodes rather than gateways: most nodes do not serve
    // chunks unpacked, so chunk requests try them last (see chunkJson).
    this.nodeUrls = new Set();
    this.fallbackUrls = gatewayUrls;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.lastAnsweredBy = null;
    this.reorder();
  }

  reorder() {
    this.gatewayUrls = [...new Set([...this.firstUrls, ...this.peerUrls, ...this.fallbackUrls])];
  }

  /** Try these node URLs (see src/network/peers.js) before the gateways; [] goes back to gateways only. */
  preferPeers(peerUrls) {
    this.peerUrls = peerUrls;
    this.noteNodes(peerUrls);
    this.reorder();
  }

  /** Remembers these addresses as nodes, not gateways (for requests that try nodes last). */
  noteNodes(urls) {
    for (const url of urls) this.nodeUrls.add(url);
  }

  /** Sources in order, nodes moved after everything else when `nodesLast`. */
  sourcesInOrder({ nodesLast = false } = {}) {
    if (!nodesLast) return this.gatewayUrls;
    return [...this.gatewayUrls.filter((url) => !this.nodeUrls.has(url)), ...this.gatewayUrls.filter((url) => this.nodeUrls.has(url))];
  }

  /** Try these sources before all others, in this order. */
  preferFirst(urls) {
    this.firstUrls = [...new Set(urls)];
    this.reorder();
  }

  /** Add more gateways (see GatewayDirectory) after the ones already known. */
  addGateways(gatewayUrls) {
    this.fallbackUrls = [...new Set([...this.fallbackUrls, ...gatewayUrls])];
    this.reorder();
  }

  /**
   * Tries each source in order until one answers. `maxSources` caps how many are asked, for
   * requests a source may simply not have (a chunk it never stored answers 404), so one
   * missing item cannot wait on every source's timeout in turn.
   */
  async request(path, { method = 'GET', body = undefined, headers = {}, readAs = 'json', firstGatewayOnly = false, maxSources = Infinity, timeoutMs = this.timeoutMs, nodesLast = false } = {}) {
    const failures = [];
    const gatewayUrls = this.sourcesInOrder({ nodesLast }).slice(0, firstGatewayOnly ? 1 : maxSources);
    for (const gatewayUrl of gatewayUrls) {
      const url = gatewayUrl + path;
      try {
        const response = await fetch(url, { method, body, headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
        this.lastAnsweredBy = gatewayUrl;
        if (readAs === 'bytes') return new Uint8Array(await response.arrayBuffer());
        const text = await response.text();
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

  // A chunk is often missing from a source (never synced, or withheld from that gateway),
  // so only a few are asked, each briefly, before the caller moves on to another chunk.
  static CHUNK_MAX_SOURCES = 4;
  static CHUNK_TIMEOUT_MS = 10000;

  /** The unpacked chunk covering a weave byte, as raw base64url text plus proofs. */
  /** GET /chunk/{endOffset}: the chunk holding byte endOffset - 1, with its proofs and absolute end. */
  async chunkJson(endOffset) {
    // Gateways first: most mining nodes keep chunks packed and answer 404 for unpacked ones,
    // and only CHUNK_MAX_SOURCES are asked, so nodes first would starve fetching.
    return this.request(`/chunk/${endOffset.toString()}`, { maxSources: ArweaveGateway.CHUNK_MAX_SOURCES, timeoutMs: ArweaveGateway.CHUNK_TIMEOUT_MS, nodesLast: true });
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
   * The address's latest transaction as the nodes record it (GET /wallet/{address}/last_tx,
   * part of the node protocol, unlike GraphQL), with its confirmation if it has one:
   * { id, confirmedAtHeight } — id null if it never sent a base-layer transaction.
   * Data items sent through bundlers do not appear here.
   */
  async latestSentTransaction(address) {
    const id = (await this.request(`/wallet/${address}/last_tx`, { readAs: 'text' })).trim();
    if (!id) return { id: null, confirmedAtHeight: null };
    try {
      const status = await this.request(`/tx/${id}/status`);
      return { id, confirmedAtHeight: status.block_height ?? null };
    } catch {
      // Pending or not yet seen by the answering source: shown without a height.
      return { id, confirmedAtHeight: null };
    }
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
