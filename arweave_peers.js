// arweave_peers.js — reaching Arweave nodes directly instead of only through gateways.
//
// Nodes answer browsers: every response carries CORS headers (add_cors_headers in
// apps/arweave/src/ar_http_iface_middleware.erl). But nodes speak plain HTTP on port 1984,
// and browsers block a page loaded over https from calling plain-http addresses ("mixed
// content"). So peers work from the downloaded single file, not from an https copy.
import { ArweaveGateway } from './arweave_gateway.js';

export class PeerAccess {
  /**
   * Why direct peer access cannot work on this page, or null if it may. Browsers do not
   * report a mixed-content block as such (the request just fails), so this is decided up
   * front from how the page was loaded.
   */
  static blockedReason(pageLocation = globalThis.location) {
    if (pageLocation?.protocol === 'https:') {
      return 'this page was loaded over https, and browsers block https pages from calling Arweave nodes, which use plain http';
    }
    return null;
  }
}

export class PeerDirectory {
  /**
   * Finds nodes that answer from this page: asks a gateway for its peer list (GET /peers,
   * "ip:port" strings), then probes a shuffled handful with GET /info.
   */
  constructor({ gateway, probeCount = 12, keepCount = 4, probeTimeoutMs = 5000, log = () => {} }) {
    Object.assign(this, { gateway, probeCount, keepCount, probeTimeoutMs, log });
  }

  static shuffled(items) {
    const copy = items.slice();
    for (let index = copy.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
  }

  async probe(peerUrl) {
    const response = await fetch(`${peerUrl}/info`, { signal: AbortSignal.timeout(this.probeTimeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = await response.json();
    return { peerUrl, height: Number(info.height) };
  }

  /**
   * Returns base URLs of peers that answered, highest chain first. `extraNodeUrls` adds
   * candidates found elsewhere (for example GatewayDirectory's Arweave nodes).
   */
  async discover(extraNodeUrls = []) {
    const peers = (await this.gateway.request('/peers')).map((peer) => `http://${peer}`);
    const candidates = PeerDirectory.shuffled([...new Set([...peers, ...extraNodeUrls])]).slice(0, this.probeCount);
    const results = await Promise.allSettled(candidates.map((peerUrl) => this.probe(peerUrl)));
    const answered = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) this.log(`${failed.length} of ${candidates.length} peers did not answer (first reason: ${failed[0].reason.message})`);
    return answered.sort((left, right) => right.height - left.height).slice(0, this.keepCount).map((result) => result.peerUrl);
  }
}

export class GatewayDirectory {
  /**
   * Finds more gateways, and the Arweave nodes they use, from an ar.io gateway's
   * GET /ar-io/peers (ar-io-node src/routes/ar-io.ts): `gateways` maps "host:port" to
   * { url, status, ... } and `arweaveNodes` maps to { url, height, ... }. ar.io gateways
   * allow any website to read it (cors() in ar-io-node src/app.ts).
   *
   * Asked of known ar.io gateways only: arweave.net answers /ar-io/peers with 404, so it
   * is not one, or does not expose that route. turbo-gateway.com answered in the live check.
   */
  static AR_IO_GATEWAY_URLS = ['https://turbo-gateway.com'];

  constructor({ arIoGatewayUrls = GatewayDirectory.AR_IO_GATEWAY_URLS, maxGateways = 20, timeoutMs = 20000, log = () => {} } = {}) {
    Object.assign(this, { maxGateways, log });
    this.registrySource = new ArweaveGateway({ gatewayUrls: arIoGatewayUrls, timeoutMs, log });
  }

  async discover() {
    const reply = await this.registrySource.request('/ar-io/peers');
    const gatewayUrls = Object.values(reply.gateways ?? {})
      .filter((entry) => typeof entry.url === 'string' && (entry.status ?? 'joined') === 'joined')
      .map((entry) => entry.url.replace(/\/+$/, ''));
    const nodeUrls = Object.values(reply.arweaveNodes ?? {})
      .filter((entry) => typeof entry.url === 'string')
      .map((entry) => entry.url.replace(/\/+$/, ''));
    return { gatewayUrls: PeerDirectory.shuffled(gatewayUrls).slice(0, this.maxGateways), nodeUrls };
  }
}

export class SourceTester {
  /**
   * Tries gateways and nodes with GET /info and reports which answer, how fast, and at what
   * chain height, so the fastest working ones can be tried first and the reasons for
   * failures shown. Plain-http sources are skipped with a reason when the page cannot call
   * them (see PeerAccess).
   */
  constructor({ timeoutMs = 8000, pageLocation = globalThis.location } = {}) {
    Object.assign(this, { timeoutMs, pageLocation });
  }

  static normalized(text) {
    const trimmed = text.trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    return /^https?:\/\//i.test(trimmed) ? trimmed : `${/:\d+$/.test(trimmed) ? 'http' : 'https'}://${trimmed}`;
  }

  /** Parses a list typed by a person: one address per line or separated by spaces or commas. */
  static parseList(text) {
    return [...new Set(text.split(/[\s,]+/).map(SourceTester.normalized).filter(Boolean))];
  }

  async test(url) {
    if (url.startsWith('http:') && PeerAccess.blockedReason(this.pageLocation)) {
      return { url, ok: false, error: 'plain http, which this https page may not call' };
    }
    const started = performance.now();
    try {
      const response = await fetch(`${url}/info`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const info = await response.json();
      if (!Number.isFinite(Number(info.height))) throw new Error('answered, but not with Arweave node info');
      return { url, ok: true, milliseconds: Math.round(performance.now() - started), height: Number(info.height) };
    } catch (error) {
      // A blocked or unreachable host usually shows as a bare "Failed to fetch" TypeError.
      const reason = error.name === 'TimeoutError' ? `no answer in ${this.timeoutMs / 1000} s` : error.message;
      return { url, ok: false, error: reason };
    }
  }

  /** Tests all at once; working sources first, fastest first. */
  async testAll(urls) {
    const results = await Promise.all(urls.map((url) => this.test(url)));
    return results.sort((left, right) => (right.ok - left.ok) || ((left.milliseconds ?? 0) - (right.milliseconds ?? 0)));
  }
}
