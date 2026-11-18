// Opens the built single file from disk in headless Chromium and checks the main paths:
// real RandomX, replaying the sample block to its own solution, the explorer, packing for
// another address, and restoring packed chunks after a reload.
// Run: npm ci && node test/check-page.cjs [path/to/weave-tab-miner.html]
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
    console.log(`      wait: ${await this.text(page, '#expectedWait')} | ${await this.text(page, '#limitList')} | ${await this.text(page, '#rangeHitNote')}`);

    const sharedAddress = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../data/public-key.json'), 'utf8')).address;
    this.check('opens with the shared key', (await page.inputValue('#walletAddressInput')) === sharedAddress, sharedAddress);
    await page.click('#verifySampleButton');
    await this.waitForLog(page, 'verification ready', 60000);
    await page.fill('#addressInput', await page.inputValue('#walletAddressInput'));
    await page.click('#holdButton');
    this.check('the sample miner is for checking only', /checking only/.test(await this.text(page, '#identityStatus')));

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
    await page.waitForFunction(() => /^Packed/.test(document.getElementById('packStatus').textContent), null, { timeout: 600000 });
    this.check('packing one chunk for another address', true, `${await this.text(page, '#packStatus')} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    // Saving follows the status update, so wait for its log line rather than reading it at once.
    const saved = await this.waitForLog(page, 'saved 1 packed chunk\\b', 30000).then(() => true, () => false);
    this.check('packed chunks saved to browser storage', saved, await this.text(page, '#storageNote'));

    // A typed seed is tested, listed with its result, and remembered across a reload.
    const seed = 'https://seed.invalid';
    await page.fill('#seedInput', seed);
    started = Date.now();
    await page.click('#testSourcesButton');
    await this.waitForLog(page, 'source test:', 120000);
    const sourceList = await this.text(page, '#sourceResults');
    this.check('testing sources lists the seed with its result', sourceList.includes(`✗ ${seed}`), `${((Date.now() - started) / 1000).toFixed(0)} s: ${await this.text(page, '#peerStatus')}`);

    await page.reload();
    await this.waitForLog(page, 'ready:', 120000);
    this.check('the seed list is remembered', (await page.inputValue('#seedInput')) === seed);
    await page.fill('#addressInput', address);
    await page.click('#addressButton');
    await page.waitForTimeout(1000);
    this.check('reloading restores it', /restored 1 packed chunk\b/.test(await this.text(page, '#activityLog')), await this.text(page, '#heldBytes'));

    // Restored chunks stay on disk; a step aimed at one must read it back to try its nonces.
    await page.check('#aimCheckbox');
    await page.check('#vdfModeReplay');
    await page.click('#startButton');
    await page.waitForFunction(() => /no pass|found/.test(document.getElementById('stepRows').textContent), null, { timeout: 120000 }).catch(() => {});
    await page.click('#stopButton');
    await page.uncheck('#aimCheckbox');
    this.check('a step reads a held chunk back from storage', /no pass|found/.test(await this.text(page, '#stepRows')), (await this.text(page, '#stepRows')).slice(0, 120));

    // Export this address's chunk, then import it into a fresh browser profile.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportChunksButton')]);
    const archivePath = require('node:path').join(require('node:os').tmpdir(), download.suggestedFilename());
    await download.saveAs(archivePath);
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    freshPage.on('pageerror', (error) => errors.push(error.message));
    await freshPage.goto(this.url);
    await this.waitForLog(freshPage, 'ready:', 120000);
    await freshPage.setInputFiles('#importChunksInput', archivePath);
    await this.waitForLog(freshPage, 'imported 1 packed chunks', 30000).catch(() => {});
    await freshPage.click('#savedAddresses button');
    await freshPage.waitForTimeout(1000);
    this.check('export then import into a fresh browser', /restored 1 packed chunk\b/.test(await this.text(freshPage, '#activityLog')), `${download.suggestedFilename()} → ${await this.text(freshPage, '#heldBytes')}`);
    await freshContext.close();

    // The bridge: a copy served over http (standing in for the website) holds the chunk;
    // a copy opened from disk asks for it, and the website window sends it after consent.
    const server = require('node:http').createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(require('node:fs').readFileSync(this.url.replace('file://', '')));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const websiteUrl = `http://127.0.0.1:${server.address().port}/weave-tab-miner.html`;
    const bridgeContext = await browser.newContext();
    const website = await bridgeContext.newPage();
    website.on('pageerror', (error) => errors.push(error.message));
    await website.goto(websiteUrl);
    await this.waitForLog(website, 'ready:', 120000);
    await website.setInputFiles('#importChunksInput', archivePath);
    await this.waitForLog(website, 'imported 1 packed chunks', 30000);
    await website.close();
    const diskCopy = await bridgeContext.newPage();
    diskCopy.on('pageerror', (error) => errors.push(error.message));
    await diskCopy.goto(this.url);
    await this.waitForLog(diskCopy, 'ready:', 120000);
    await diskCopy.evaluate((url) => localStorage.setItem('weave-tab-miner.share-source', url), websiteUrl);
    const [popup] = await Promise.all([bridgeContext.waitForEvent('page'), diskCopy.click('#bringChunksButton')]);
    await popup.waitForSelector('#shareRequest:not([hidden])', { timeout: 120000 });
    await popup.click('#sendChunksButton');
    await this.waitForLog(diskCopy, 'brought 1 chunks from the website copy', 60000).catch(() => {});
    this.check('a copy on disk brings chunks from the website copy', /brought 1 chunks/.test(await this.text(diskCopy, '#activityLog')), await this.text(diskCopy, '#holdStatus'));
    await bridgeContext.close();
    server.close();

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

new PageCheck(process.argv[2] ?? require('node:path').join(__dirname, '../dist/weave-tab-miner.html')).run().catch((error) => { console.error(error); process.exitCode = 1; });
