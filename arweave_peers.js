// arweave_peers.js — reaching Arweave nodes directly instead of only through gateways.
//
// Nodes answer browsers: every response carries CORS headers (add_cors_headers in
// apps/arweave/src/ar_http_iface_middleware.erl). But nodes speak plain HTTP on port 1984,
// and browsers block a page loaded over https from calling plain-http addresses ("mixed
// content"). So peers work from the downloaded single file, not from an https copy.

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

  /** Returns base URLs ("http://ip:port") of peers that answered, highest chain first. */
  async discover() {
    const peers = await this.gateway.request('/peers');
    const candidates = PeerDirectory.shuffled(peers).slice(0, this.probeCount).map((peer) => `http://${peer}`);
    const results = await Promise.allSettled(candidates.map((peerUrl) => this.probe(peerUrl)));
    const answered = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) this.log(`${failed.length} of ${candidates.length} peers did not answer (first reason: ${failed[0].reason.message})`);
    return answered.sort((left, right) => right.height - left.height).slice(0, this.keepCount).map((result) => result.peerUrl);
  }
}
