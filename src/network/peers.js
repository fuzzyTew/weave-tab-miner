// src/network/peers.js — reaching Arweave nodes directly instead of only through gateways.
//
// Nodes answer browsers: every response carries CORS headers (add_cors_headers in
// apps/arweave/src/ar_http_iface_middleware.erl). But nodes speak plain HTTP on port 1984,
// and browsers block a page loaded over https from calling plain-http addresses ("mixed
// content"). So peers work from the downloaded single file, not from an https copy.
import { ArweaveGateway } from './gateway.js';
import { VdfServerClient } from './vdf-client.js';

export class PeerAccess {
  /**
   * Why direct peer access cannot work on this page, or null if it may. Browsers do not
   * report a mixed-content block as such (the request just fails), so this is decided up
   * front from how the page was loaded.
   */
  static mixedContentAllowed = false;

  /**
   * Set when the person says their browser allows insecure content for this site (a
   * per-site browser setting), so plain-http nodes are tried even from an https page.
   */
  static allowMixedContent(allowed) {
    PeerAccess.mixedContentAllowed = Boolean(allowed);
  }

  static blockedReason(pageLocation = globalThis.location) {
    if (pageLocation?.protocol === 'https:' && !PeerAccess.mixedContentAllowed) {
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

  constructor({ arIoGatewayUrls = GatewayDirectory.AR_IO_GATEWAY_URLS, maxGateways = 20, timeoutMs = 20000, solanaRegistry = new SolanaGatewayRegistry({ timeoutMs }), log = () => {} } = {}) {
    Object.assign(this, { maxGateways, solanaRegistry, log });
    this.registrySource = new ArweaveGateway({ gatewayUrls: arIoGatewayUrls, timeoutMs, log });
  }

  /**
   * Asks an ar.io gateway first (it also lists Arweave nodes). When none answers, as on
   * networks that block ar.io gateways but not Solana, reads the registry itself from Solana
   * (gateways only).
   */
  async discover() {
    try {
      return await this.discoverFromGateway();
    } catch (gatewayError) {
      this.log(`ar.io gateways did not list peers (${gatewayError.message.split('\n')[0]}); reading the registry from Solana`);
      const gatewayUrls = await this.solanaRegistry.gatewayUrls();
      return { gatewayUrls: PeerDirectory.shuffled(gatewayUrls).slice(0, this.maxGateways), nodeUrls: [] };
    }
  }

  async discoverFromGateway() {
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

  /**
   * Tests GET /info, and with `checkVdf` also GET /vdf: the result then carries `vdf` (true
   * when it served a VDF update) and `vdfError`. A VDF server need not answer /info, so a
   * source can be `ok: false` and still `vdf: true`.
   */
  async test(url, { checkVdf = false } = {}) {
    if (url.startsWith('http:') && PeerAccess.blockedReason(this.pageLocation)) {
      return { url, ok: false, error: 'plain http, which this https page may not call' };
    }
    const result = await this.testInfo(url);
    if (!checkVdf) return result;
    try {
      await new VdfServerClient({ baseUrls: [url], timeoutMs: this.timeoutMs }).fetchUpdate(url);
      return { ...result, vdf: true };
    } catch (error) {
      return { ...result, vdf: false, vdfError: error.name === 'TimeoutError' ? `no answer in ${this.timeoutMs / 1000} s` : error.message };
    }
  }

  async testInfo(url) {
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

  /**
   * Tests in the order given, `concurrency` at a time, and stops starting new tests once
   * `enoughWorking` have answered (so a long seed list does not knock on hundreds of hosts).
   * Returns the tested ones, working first, fastest first; untested ones are left out.
   */
  async testAll(urls, { concurrency = 6, enoughWorking = Infinity, checkVdf = false, onResult = () => {} } = {}) {
    const results = [];
    let nextIndex = 0;
    const workingCount = () => results.filter((result) => result.ok).length;
    const testNextUntilEnough = async () => {
      while (nextIndex < urls.length && workingCount() < enoughWorking) {
        const result = await this.test(urls[nextIndex++], { checkVdf });
        results.push(result);
        onResult(result, results.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, testNextUntilEnough));
    return results.sort((left, right) => (right.ok - left.ok) || ((left.milliseconds ?? 0) - (right.milliseconds ?? 0)));
  }
}

export class SourceGatherer {
  /**
   * Builds a seed list on a machine with open internet (GitHub's runners), for pages opened
   * where many Arweave hosts are blocked: every ar.io gateway and Arweave node it can learn
   * of, each tested with GET /info, the ones that answered kept fastest first.
   *
   * Speeds are as seen from the gathering machine, so they only order the list; the page
   * tests again from where it is. Nodes that answer here may still refuse other networks.
   */
  constructor({ arIoGatewayUrls = GatewayDirectory.AR_IO_GATEWAY_URLS, nodeListSourceUrls = ['https://arweave.net'], tester = new SourceTester({ timeoutMs: 6000 }), log = () => {} } = {}) {
    Object.assign(this, { arIoGatewayUrls, nodeListSourceUrls, tester, log });
  }

  async gatherCandidates() {
    let gatewayUrls = [...ArweaveGateway.DEFAULT_GATEWAY_URLS];
    let nodeUrls = [];
    try {
      const found = await new GatewayDirectory({ arIoGatewayUrls: this.arIoGatewayUrls, maxGateways: Infinity, log: this.log }).discover();
      gatewayUrls.push(...found.gatewayUrls);
      nodeUrls.push(...found.nodeUrls);
      this.log(`ar.io registry: ${found.gatewayUrls.length} gateways, ${found.nodeUrls.length} nodes`);
    } catch (error) {
      this.log(`ar.io registry failed: ${error.message.split('\n')[0]}`);
    }
    try {
      const fromSolana = await new SolanaGatewayRegistry().gatewayUrls();
      gatewayUrls.push(...fromSolana);
      this.log(`Solana registry: ${fromSolana.length} gateways`);
    } catch (error) {
      this.log(`Solana registry failed: ${error.message.split('\n')[0]}`);
    }
    for (const sourceUrl of this.nodeListSourceUrls) {
      try {
        const peers = await new ArweaveGateway({ gatewayUrls: [sourceUrl], log: this.log }).request('/peers');
        nodeUrls.push(...peers.map((peer) => `http://${peer}`));
        this.log(`${sourceUrl}/peers: ${peers.length} nodes`);
      } catch (error) {
        this.log(`${sourceUrl}/peers failed: ${error.message.split('\n')[0]}`);
      }
    }
    return { gatewayUrls: [...new Set(gatewayUrls)], nodeUrls: [...new Set(nodeUrls)] };
  }

  /**
   * Returns { gatheredAt, gateways, nodes, vdfServers }; each entry { url, milliseconds,
   * height }. Every candidate, and the known public VDF servers, are also asked for /vdf.
   */
  async gather({ keepGateways = 150, keepNodes = 150, extraVdfCandidates = [] } = {}) {
    const { gatewayUrls, nodeUrls } = await this.gatherCandidates();
    const tested = async (urls) => this.tester.testAll(urls, { concurrency: 24, checkVdf: true });
    const entry = ({ url, milliseconds, height }) => ({ url, milliseconds, height });
    const gatewayResults = await tested(gatewayUrls);
    const nodeResults = await tested(nodeUrls);
    // extraVdfCandidates: e.g. the public servers by IP address, which browsers never force
    // to https (as they may a name under a domain that asked for HSTS).
    const publicVdfResults = await tested([...VdfServerClient.PUBLIC_SERVER_URLS, ...extraVdfCandidates]);
    const gateways = gatewayResults.filter((result) => result.ok).slice(0, keepGateways).map(entry);
    const nodes = nodeResults.filter((result) => result.ok).slice(0, keepNodes).map(entry);
    const vdfServers = [...publicVdfResults, ...gatewayResults, ...nodeResults].filter((result) => result.vdf).map(entry);
    for (const result of publicVdfResults) this.log(`${result.url}: /info ${result.ok ? 'ok' : result.error}; /vdf ${result.vdf ? 'ok' : result.vdfError}`);
    this.log(`served the VDF: ${vdfServers.map((entry) => entry.url).join(', ') || 'none'}`);
    this.log(`answered: ${gateways.length} of ${gatewayUrls.length} gateways, ${nodes.length} of ${nodeUrls.length} nodes; ${vdfServers.length} served the VDF`);
    return { gatheredAt: new Date().toISOString(), gateways, nodes, vdfServers };
  }
}

export class SolanaGatewayRegistry {
  /**
   * Reads ar.io's Gateway Address Registry straight from Solana, where ar.io moved it from
   * AO in 2026 (ar-io-node release 80), with one JSON-RPC getProgramAccounts call. A
   * fallback that needs no ar.io gateway: only a Solana RPC server, a different host that
   * a filter blocking Arweave sites may let through.
   *
   * Layout from @ar.io/solana-contracts 4.x (lib/gar/accounts/gateway.js), Borsh-encoded:
   * discriminator(8) operator(32) label(u32 length + UTF-8) fqdn(same) port(u16 LE)
   * protocol(u8: 0 http, 1 https) properties(string) note(string) operatorStake(u64)
   * totalDelegatedStake(u64) status(u8: 0 joined, 1 leaving, 2 gone) ...
   */
  static GAR_PROGRAM_ID = '89fNiiwgpFSPHKuqfNUkgYTYjtAJAhyqHjXmgXeppGpf';
  static GATEWAY_DISCRIMINATOR = [210, 132, 162, 254, 10, 224, 45, 86];
  static RPC_URLS = ['https://api.mainnet-beta.solana.com'];
  static STATUS_NAMES = ['joined', 'leaving', 'gone'];

  constructor({ rpcUrls = SolanaGatewayRegistry.RPC_URLS, timeoutMs = 30000 } = {}) {
    Object.assign(this, { rpcUrls, timeoutMs });
  }

  /**
   * Decodes the fields up to status; null when the bytes are not a gateway account or end
   * early. Strings longer than the account are treated as corrupt.
   */
  static decodeGateway(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const discriminator = SolanaGatewayRegistry.GATEWAY_DISCRIMINATOR;
    if (bytes.length < 40 || discriminator.some((value, index) => bytes[index] !== value)) return null;
    let offset = 40;
    const readString = () => {
      const length = view.getUint32(offset, true);
      if (offset + 4 + length > bytes.length) throw new RangeError('string runs past the account');
      const text = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 4 + length));
      offset += 4 + length;
      return text;
    };
    try {
      const label = readString();
      const fqdn = readString();
      const port = view.getUint16(offset, true);
      const protocol = bytes[offset + 2] === 1 ? 'https' : 'http';
      offset += 3;
      readString(); // properties
      readString(); // note
      offset += 16; // operatorStake, totalDelegatedStake
      const status = SolanaGatewayRegistry.STATUS_NAMES[view.getUint8(offset)] ?? 'unknown';
      return { label, fqdn, port, protocol, status };
    } catch {
      return null;
    }
  }

  static urlFor({ fqdn, port, protocol }) {
    const defaultPort = protocol === 'https' ? 443 : 80;
    return `${protocol}://${fqdn}${port === defaultPort ? '' : `:${port}`}`;
  }

  async accounts() {
    const base64Discriminator = btoa(String.fromCharCode(...SolanaGatewayRegistry.GATEWAY_DISCRIMINATOR));
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
      params: [SolanaGatewayRegistry.GAR_PROGRAM_ID, {
        encoding: 'base64', commitment: 'confirmed',
        filters: [{ memcmp: { offset: 0, bytes: base64Discriminator, encoding: 'base64' } }],
      }],
    });
    const failures = [];
    for (const rpcUrl of this.rpcUrls) {
      try {
        const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(this.timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
        const reply = await response.json();
        if (reply.error) throw new Error(`RPC error ${reply.error.code}: ${reply.error.message}`);
        return reply.result.map((entry) => Uint8Array.from(atob(entry.account.data[0]), (character) => character.charCodeAt(0)));
      } catch (error) {
        failures.push(`${rpcUrl}: ${error.message}`);
      }
    }
    throw new Error(`no Solana RPC answered (${failures.join('; ')})`);
  }

  /** Base URLs of joined gateways, as registered. */
  async gatewayUrls() {
    const gateways = (await this.accounts()).map(SolanaGatewayRegistry.decodeGateway).filter(Boolean);
    return [...new Set(gateways.filter((gateway) => gateway.status === 'joined' && gateway.fqdn).map(SolanaGatewayRegistry.urlFor))];
  }
}
