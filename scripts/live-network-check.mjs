// scripts/live-network-check.mjs — tries every live request the page and server mode make, against
// real gateways and nodes, and reports which answer and whether the answers parse. Meant for
// a machine that can reach Arweave (GitHub's runners can; the machine this was written on
// could not). Run: node scripts/live-network-check.mjs
import {
  Bytes, ConsensusConstants, Difficulty, Replica29Layout, VdfChain, VdfSession,
} from '../src/miner.js';
import { ArweaveGateway } from '../src/gateway.js';
import { GatewayDirectory, PeerDirectory, SolanaGatewayRegistry } from '../src/peers.js';
import { VdfServerClient, VdfUpdate } from '../src/vdf-client.js';

class LiveNetworkCheck {
  /**
   * Runs each check against each gateway on its own, so one gateway's failure cannot hide
   * behind another's success. "Required" checks fail the run when no source passes them;
   * the rest (VDF servers, ar.io registry, direct nodes) are reported only.
   */
  static SAMPLE_ADDRESS = 'wYnRY0GUYWkoisS45Djguy5DZ5Xt3z1bE0KDPnq66c4'; // mined block 2,040,257

  constructor() {
    this.results = [];
  }

  record(source, name, required, outcome) {
    this.results.push({ source, name, required, ...outcome });
    const mark = outcome.ok ? 'PASS' : required ? 'FAIL' : 'none';
    console.log(`${mark}  ${source}  ${name}${outcome.detail ? ' — ' + outcome.detail : ''}`);
  }

  async attempt(source, name, required, action) {
    try {
      this.record(source, name, required, { ok: true, detail: await action() });
    } catch (error) {
      this.record(source, name, required, { ok: false, detail: error.message.split('\n')[0].slice(0, 200) });
    }
  }

  async checkGateway(url) {
    const gateway = new ArweaveGateway({ gatewayUrls: [url], timeoutMs: 30000 });
    let block = null;
    await this.attempt(url, 'GET /block/current parses, solution passes its difficulty', true, async () => {
      block = await gateway.currentBlock();
      const session = VdfSession.fromBlock(block);
      const passes = Difficulty.passes(Bytes.fromBase64Url(block.hash), block.recall_byte2 === undefined, BigInt(block.diff));
      if (!passes) throw new Error(`block ${block.height} hash does not pass its own difficulty`);
      return `height ${session.height}, step ${session.latestStepNumber}, ${session.stepOutputsNewestFirst.length} steps`;
    });
    if (block) {
      await this.attempt(url, 'its last VDF checkpoint recomputes to its output', true, async () => {
        const info = block.nonce_limiter_info;
        const checkpoints = info.last_step_checkpoints.map(Bytes.fromBase64Url);
        const salt = VdfChain.saltNumberForStep(Number(info.global_step_number) - 1) + 24n;
        const output = new VdfChain({ iterationsPerCheckpoint: Number(info.vdf_difficulty) }).computeCheckpoint(salt, checkpoints[1]);
        if (!Bytes.equal(output, Bytes.fromBase64Url(info.output))) throw new Error('mismatch');
        return 'matches';
      });
      await this.attempt(url, 'GET /chunk/{offset} for a byte in the block\'s partition', true, async () => {
        const byte = BigInt(block.recall_byte);
        const reply = await gateway.chunkJson(byte);
        const chunk = Bytes.fromBase64Url(reply.chunk);
        if (!reply.data_path || !reply.tx_path) throw new Error('no data_path or tx_path in the reply');
        return `${chunk.length} bytes, bucket end ${Replica29Layout.bucketEndOffsetForByte(byte)}`;
      });
    }
    await this.attempt(url, 'GET /price/1000', true, async () => `${await gateway.priceWinston(1000)} winston`);
    await this.attempt(url, 'GET /tx_anchor', true, async () => {
      const anchor = await gateway.transactionAnchor();
      if (Bytes.fromBase64Url(anchor).length !== 48 && Bytes.fromBase64Url(anchor).length !== 32) throw new Error(`odd anchor ${anchor}`);
      return anchor.slice(0, 12) + '…';
    });
    await this.attempt(url, 'GET /wallet/{address}/balance', true, async () => `${await gateway.balanceWinston(LiveNetworkCheck.SAMPLE_ADDRESS)} winston`);
    await this.attempt(url, 'GET /wallet/{address}/reserved_rewards_total', false, async () => `${await gateway.reservedRewardsWinston(LiveNetworkCheck.SAMPLE_ADDRESS)} winston`);
    await this.attempt(url, 'POST /graphql transaction history', true, async () => {
      const history = await gateway.transactionHistory(LiveNetworkCheck.SAMPLE_ADDRESS, 3);
      return `${history.sent.length} sent, ${history.received.length} received`;
    });
    await this.attempt(url, 'GET /peers', false, async () => `${(await gateway.request('/peers')).length} peers`);
    await this.attempt(url, 'GET /vdf (VDF server)', false, async () => {
      const response = await fetch(`${url}/vdf`, { signal: AbortSignal.timeout(15000) });
      const body = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Raw shape, so a parse failure can be diagnosed from the log.
      console.log(`      /vdf from ${url}: ${body.length} bytes, content-type ${response.headers.get('content-type')}, first 160 bytes ${Bytes.toHex(body.subarray(0, 160))}`);
      console.log(`      last 64 bytes ${Bytes.toHex(body.subarray(body.length - 64))}`);
      if (/text\/html|application\/json/i.test(response.headers.get('content-type') ?? '')) throw new Error(`answered with ${response.headers.get('content-type')}, not a VDF update`);
      const update = VdfUpdate.parse(body);
      return `step ${update.stepNumber}, ${update.stepsNewestFirst.length} steps`;
    });
  }

  async checkPublicVdfServers() {
    for (const url of VdfServerClient.PUBLIC_SERVER_URLS) {
      await this.attempt(url, 'GET /vdf (public VDF server)', false, async () => {
        const update = await new VdfServerClient({ baseUrls: [url], timeoutMs: 15000 }).fetchUpdate(url);
        return `step ${update.stepNumber}, ${update.stepsNewestFirst.length} steps`;
      });
    }
  }

  async checkRegistryAndNodes() {
    await this.attempt('Solana registry', 'getProgramAccounts for ar.io gateways', false, async () => {
      const urls = await new SolanaGatewayRegistry().gatewayUrls();
      return `${urls.length} joined gateways, e.g. ${urls.slice(0, 3).join(', ')}`;
    });
    let nodeUrls = [];
    await this.attempt('ar.io registry', 'GET /ar-io/peers', false, async () => {
      const found = await new GatewayDirectory({ maxGateways: 1000 }).discover();
      nodeUrls = found.nodeUrls;
      return `${found.gatewayUrls.length} joined gateways, ${found.nodeUrls.length} Arweave nodes`;
    });
    const gateway = new ArweaveGateway({ timeoutMs: 30000 });
    await this.attempt('direct nodes', 'probe nodes over plain http (as a downloaded page would)', false, async () => {
      const peers = await new PeerDirectory({ gateway, probeCount: 16, keepCount: 16 }).discover(nodeUrls);
      if (!peers.length) throw new Error('no node answered');
      const direct = new ArweaveGateway({ gatewayUrls: [peers[0]], timeoutMs: 30000 });
      const block = await direct.currentBlock();
      return `${peers.length} answered; ${peers[0]} served block ${block.height}`;
    });
  }

  async run() {
    for (const url of [...new Set([...ArweaveGateway.DEFAULT_GATEWAY_URLS, ...GatewayDirectory.AR_IO_GATEWAY_URLS])]) await this.checkGateway(url);
    await this.checkPublicVdfServers();
    await this.checkRegistryAndNodes();

    const required = [...new Set(this.results.filter((result) => result.required).map((result) => result.name))];
    const missing = required.filter((name) => !this.results.some((result) => result.name === name && result.ok));
    console.log(missing.length ? `no source passed: ${missing.join('; ')}` : 'every required request worked on at least one source');
    process.exitCode = missing.length ? 1 : 0;
  }
}

new LiveNetworkCheck().run();
