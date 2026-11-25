// scripts/localnet-page.mjs — opens the built page in a headless browser against a running
// Arweave localnet (through scripts/localnet-proxy.mjs), presses the one-button start, and
// waits for the node to take blocks the tab mined and posted on its own: the whole path a
// person's tab takes (state, chunks, packing, VDF, mining, building, signing, posting).
// Run by the localnet workflow's page mode:
//   node scripts/localnet-page.mjs [blocks to wait for, default 2] [minutes allowed, default 30] [proxy URL]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { LocalnetClient } from './localnet-client.mjs';

class LocalnetPageRun {
  static POLL_MS = 2000;
  // Fails this soon after the page's status texts and the node's height stop changing, so
  // a hang shows where it stopped instead of waiting out the whole allowance.
  static STALL_MS = 180000;
  // Page text worth following as it changes: where the tab is, stage by stage.
  static STATUS_ELEMENTS = ['quickStartStages', 'holdStatus', 'packStatus', 'vdfStatus', 'publishStatus'];

  constructor({ blocksWanted, minutesAllowed, proxyUrl }) {
    Object.assign(this, { blocksWanted, minutesAllowed, proxyUrl });
    this.client = new LocalnetClient();
  }

  /** The page's status texts by element id, as one object. */
  async statuses(page) {
    return page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.innerText.trim() ?? ''])), LocalnetPageRun.STATUS_ELEMENTS);
  }

  async run() {
    const { chromium } = createRequire(import.meta.url)('playwright-core');
    const startHeight = await this.client.height();
    console.log(`localnet at height ${startHeight}; waiting for ${this.blocksWanted} blocks from the tab`);
    const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
    const page = await browser.newPage();
    page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) console.log(`page ${message.type()}: ${message.text()}`); });
    page.on('pageerror', (error) => console.log(`page error: ${error.message}`));
    const url = `${pathToFileURL(resolve('dist/weave-tab-miner.html')).href}?localnet=${encodeURIComponent(this.proxyUrl)}`;
    await page.goto(url);
    await page.waitForFunction(() => /ready:/.test(document.getElementById('activityLog')?.textContent ?? ''), null, { timeout: 120000 });
    await page.click('#quickStartButton');

    const deadline = Date.now() + this.minutesAllowed * 60000;
    const shown = {};
    let taken = [];
    let lastChange = Date.now();
    let stalled = false;
    while (Date.now() < deadline) {
      if (Date.now() - lastChange > LocalnetPageRun.STALL_MS) {
        stalled = true;
        break;
      }
      await new Promise((done) => setTimeout(done, LocalnetPageRun.POLL_MS));
      for (const [id, text] of Object.entries(await this.statuses(page))) {
        if (text && text !== shown[id]) {
          console.log(`[${id}] ${id === 'quickStartStages' ? text.split('\n').at(-1) : text}`);
          lastChange = Date.now();
        }
        shown[id] = text;
      }
      const height = await this.client.height();
      for (let next = startHeight + 1 + taken.length; next <= height; next++) {
        const block = await this.client.get(`/block/height/${next}`);
        taken.push(block);
        lastChange = Date.now();
        console.log(`TAKEN  block ${next} (${block.indep_hash.slice(0, 12)}…) rewarding ${block.reward_addr.slice(0, 12)}…, ${block.txs.length} transactions, VDF step ${block.nonce_limiter_info.global_step_number}`);
      }
      if (taken.length >= this.blocksWanted) break;
    }
    const log = await page.evaluate(() => document.getElementById('activityLog')?.innerText ?? '');
    console.log(`---- the page's activity log ----\n${log}`);
    await page.screenshot({ path: 'localnet-page.png', fullPage: true });
    await browser.close();
    if (taken.length < this.blocksWanted) {
      const why = stalled ? `nothing changed for ${LocalnetPageRun.STALL_MS / 1000} s` : `${this.minutesAllowed} minutes passed`;
      console.log(`FAIL  the node took ${taken.length} of ${this.blocksWanted} blocks from the tab before ${why}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS  the node took ${taken.length} blocks mined and posted by the tab`);
    }
  }
}

await new LocalnetPageRun({
  blocksWanted: Number(process.argv[2] ?? 2), minutesAllowed: Number(process.argv[3] ?? 30), proxyUrl: process.argv[4] ?? 'http://127.0.0.1:1985',
}).run();
