// Opens the built single file from disk in headless Chromium and checks the main paths:
// real RandomX, replaying the sample block to its own solution, the explorer, packing for
// another address, and restoring packed chunks after a reload.
// Run: npm ci && node check_page.cjs [path/to/weave-tab-miner.html]
const path = require('node:path');
// playwright-core drives an installed browser without downloading one. In CI it uses the
// runner's own Google Chrome (PLAYWRIGHT_CHANNEL=chrome); elsewhere a Playwright-installed
// Chromium, or the browser named by PLAYWRIGHT_CHANNEL.
const { chromium } = (() => {
  try { return require('playwright-core'); } catch { return require('playwright'); }
})();

class PageCheck {
  constructor(htmlPath) {
    this.url = `file://${path.resolve(htmlPath)}`;
    this.failures = 0;
  }

  check(name, passed, detail = '') {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!passed) this.failures++;
  }

  async text(page, selector) {
    return (await page.textContent(selector)).replace(/\s+/g, ' ').trim();
  }

  async waitForLog(page, pattern, timeout) {
    await page.waitForFunction((source) => new RegExp(source).test(document.getElementById('activityLog').textContent), pattern, { timeout });
  }

  async run() {
    const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    let started = Date.now();
    await page.goto(this.url);
    await this.waitForLog(page, 'ready:', 120000);
    await this.waitForLog(page, 'RandomX ready|RandomX unavailable', 120000);
    this.check('RandomX runs in the page', /real/.test(await this.text(page, '#randomxStatus')), `${await this.text(page, '#randomxStatus')} after ${((Date.now() - started) / 1000).toFixed(0)} s`);
    console.log(`      wait: ${await this.text(page, '#expectedWait')} | ${await this.text(page, '#limitHeadline')}`);

    started = Date.now();
    await page.click('#startButton');
    await page.waitForSelector('#solutionBanner:not([hidden])', { timeout: 120000 });
    const banner = await this.text(page, '#solutionBanner');
    this.check('replaying the sample block finds its own solution', /own solution/.test(banner) && /nonce 51/.test(banner), `${((Date.now() - started) / 1000).toFixed(0)} s: ${banner.slice(0, 120)}`);
    const explorer = await this.text(page, '#explorerRows');
    this.check('explorer shows H0, H2 and source links', /H0 = RandomX/.test(explorer) && /H2/.test(explorer) && (await page.locator('#explorerRows a').count()) > 10);

    // Pack one sample chunk (32 entropies) for another address, then reload and expect it restored.
    const address = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await page.fill('#chunkCountInput', '1');
    await page.fill('#addressInput', address);
    await page.click('#addressButton');
    started = Date.now();
    await page.click('#holdButton');
    await page.waitForFunction(() => /^Packed/.test(document.getElementById('holdStatus').textContent), null, { timeout: 600000 });
    this.check('packing one chunk for another address', true, `${await this.text(page, '#holdStatus')} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    // Saving follows the status update, so wait for its log line rather than reading it at once.
    const saved = await this.waitForLog(page, 'saved 1 packed chunk\\b', 30000).then(() => true, () => false);
    this.check('packed chunks saved to browser storage', saved, await this.text(page, '#storageNote'));

    await page.reload();
    await this.waitForLog(page, 'ready:', 120000);
    await page.fill('#addressInput', address);
    await page.click('#addressButton');
    await page.waitForTimeout(1000);
    this.check('reloading restores it', /restored 1 packed chunk\b/.test(await this.text(page, '#activityLog')), await this.text(page, '#heldBytes'));

    await page.setViewportSize({ width: 400, height: 900 });
    this.check('no sideways scroll at phone width', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.screenshot({ path: 'page-check.png', fullPage: true });
    this.check('no page errors', errors.length === 0, errors.join(' | '));
    await browser.close();
    console.log(this.failures === 0 ? 'all checks passed' : `${this.failures} check(s) failed`);
    process.exitCode = this.failures === 0 ? 0 : 1;
  }
}

new PageCheck(process.argv[2] ?? 'weave-tab-miner.html').run().catch((error) => { console.error(error); process.exitCode = 1; });
