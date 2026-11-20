// scripts/vdf-pace-check.mjs — how fast VDF steps really come: the network's own pace over recent
// blocks (steps between blocks over seconds between them), and each reachable VDF server's
// pace and request time, polled for a minute. Tells "the network is slower than one step a
// second" apart from "this server, or reaching it, is slow". Needs the network.
// Run: node scripts/vdf-pace-check.mjs [seconds to poll each server]   (default: 60)
import { VdfServerClient } from '../src/network/vdf-client.js';

class VdfPaceCheck {
  static GATEWAY = 'https://arweave.net';
  static BLOCKS_MEASURED = 50;

  constructor(pollSeconds) {
    this.pollSeconds = pollSeconds;
  }

  async json(path) {
    const response = await fetch(VdfPaceCheck.GATEWAY + path, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }

  async networkPace() {
    const tip = await this.json('/block/current');
    const old = await this.json(`/block/height/${tip.height - VdfPaceCheck.BLOCKS_MEASURED}`);
    const steps = tip.nonce_limiter_info.global_step_number - old.nonce_limiter_info.global_step_number;
    const seconds = tip.timestamp - old.timestamp;
    console.log(`network: ${steps} steps in ${seconds} s over the last ${VdfPaceCheck.BLOCKS_MEASURED} blocks = ${(steps / seconds).toFixed(3)} steps a second`);
  }

  async serverPace(baseUrl) {
    const client = new VdfServerClient({ baseUrls: [baseUrl], timeoutMs: 10000 });
    const requestMs = [];
    let firstStep = null;
    let lastStep = null;
    let gaps = 0;
    const started = Date.now();
    while (Date.now() - started < this.pollSeconds * 1000) {
      const requestStarted = Date.now();
      let update;
      try {
        update = await client.fetchUpdate(baseUrl);
      } catch (error) {
        console.log(`${baseUrl}: ${error.cause?.message ?? error.message}`);
        return;
      }
      requestMs.push(Date.now() - requestStarted);
      const oldestHeld = update.stepNumber - update.stepsNewestFirst.length + 1;
      if (lastStep !== null && oldestHeld > lastStep + 1) gaps += oldestHeld - lastStep - 1;
      firstStep ??= update.stepNumber;
      lastStep = Math.max(lastStep ?? 0, update.stepNumber);
      await new Promise((resolve) => setTimeout(resolve, VdfServerClient.POLL_INTERVAL_MS));
    }
    const seconds = (Date.now() - started) / 1000;
    const meanMs = requestMs.reduce((total, ms) => total + ms, 0) / requestMs.length;
    console.log(`${baseUrl}: ${lastStep - firstStep} steps in ${seconds.toFixed(0)} s = ${((lastStep - firstStep) / seconds).toFixed(3)} steps a second; requests ${Math.round(meanMs)} ms on average (${Math.min(...requestMs)}–${Math.max(...requestMs)}); ${gaps} steps fell between polls (each update holds only the newest 2)`);
  }

  async run() {
    try {
      await this.networkPace();
    } catch (error) {
      console.log(`network pace: ${error.message}`);
    }
    const servers = [...VdfServerClient.PUBLIC_SERVER_URLS, 'http://207.254.22.95:1984', 'http://38.22.0.55:1984'];
    for (const url of servers) await this.serverPace(url);
  }
}

await new VdfPaceCheck(Number(process.argv[2] ?? 60)).run();
