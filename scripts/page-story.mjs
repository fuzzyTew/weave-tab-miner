// scripts/page-story.mjs — what a newcomer sees, stage by stage: opens the built page in a
// headless browser, presses the one-button start, and takes a screenshot (desktop first
// screen and full page, and phone first screen) whenever the page's status changes, with
// the activity log at the end. For reviewing the page against user stories.
// Run: node scripts/page-story.mjs [output directory] [minutes, default 4] [localnet proxy URL]
// PLAYWRIGHT_CHANNEL=chrome uses an installed Chrome instead of Playwright's own.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

class PageStory {
  static VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
  // Status texts a person watches; a change in any is a new stage.
  static STATUS_ELEMENTS = ['quickStartStages', 'holdStatus', 'vdfStatus', 'publishStatus', 'storageTargetText'];
  static POLL_MS = 1000;
  // At most one shot this often, so a status that changes every step does not flood the set.
  static MIN_SHOT_GAP_MS = 20_000;

  constructor({ outputDirectory, minutes, localnetUrl }) {
    Object.assign(this, { outputDirectory, minutes, localnetUrl });
    this.shotCount = 0;
  }

  pageUrl() {
    const url = pathToFileURL(resolve('dist/weave-tab-miner.html'));
    if (this.localnetUrl) url.searchParams.set('localnet', this.localnetUrl);
    return url.href;
  }

  /** The status texts, joined, so a change in any is seen. */
  async statusSnapshot(page) {
    return page.evaluate((ids) => ids.map((id) => document.getElementById(id)?.innerText.trim() ?? '').join('\n'), PageStory.STATUS_ELEMENTS);
  }

  /** The newest quick-start stage, or the first status line, as a short label for file names. */
  async stageLabel(page) {
    const stage = await page.evaluate(() => document.getElementById('quickStartStages')?.lastElementChild?.textContent ?? '');
    return (stage || 'start').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48).replace(/^-|-$/g, '');
  }

  /** Desktop first screen and full page, and the phone page's first screen, for this stage. */
  async shoot(pages, note) {
    const index = String(++this.shotCount).padStart(2, '0');
    const label = await this.stageLabel(pages.desktop);
    await pages.desktop.screenshot({ path: `${this.outputDirectory}/${index}-${label}-desktop.png` });
    await pages.desktop.screenshot({ path: `${this.outputDirectory}/${index}-${label}-desktop-full.png`, fullPage: true });
    await pages.phone.screenshot({ path: `${this.outputDirectory}/${index}-${label}-phone.png` });
    console.log(`${index} ${label}: ${note}`);
  }

  async run() {
    const { chromium } = createRequire(import.meta.url)('playwright-core');
    mkdirSync(this.outputDirectory, { recursive: true });
    const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
    const pages = {};
    for (const [name, viewport] of Object.entries(PageStory.VIEWPORTS)) {
      pages[name] = await browser.newPage({ viewport });
      pages[name].on('pageerror', (error) => console.log(`${name} page error: ${error.message}`));
      await pages[name].goto(this.pageUrl());
      await pages[name].waitForFunction(() => /ready:/.test(document.getElementById('activityLog')?.textContent ?? ''), null, { timeout: 120000 });
    }
    await this.shoot(pages, 'as first opened');

    // Both widths press the button, so each shows its own progress; the desktop one decides stages.
    await Promise.all(Object.values(pages).map((page) => page.click('#quickStartButton')));
    const deadline = Date.now() + this.minutes * 60000;
    let lastSnapshot = await this.statusSnapshot(pages.desktop);
    let lastShotAt = Date.now();
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, PageStory.POLL_MS));
      const snapshot = await this.statusSnapshot(pages.desktop);
      if (snapshot !== lastSnapshot && Date.now() - lastShotAt >= PageStory.MIN_SHOT_GAP_MS) {
        await this.shoot(pages, snapshot.split('\n').filter(Boolean).at(-1)?.slice(0, 160) ?? '');
        lastShotAt = Date.now();
      }
      lastSnapshot = snapshot;
    }
    await this.shoot(pages, `after ${this.minutes} minutes`);
    const log = await pages.desktop.evaluate(() => document.getElementById('activityLog')?.innerText ?? '');
    writeFileSync(`${this.outputDirectory}/activity-log.txt`, log);
    await browser.close();
  }
}

await new PageStory({
  outputDirectory: process.argv[2] ?? 'page-story', minutes: Number(process.argv[3] ?? 4), localnetUrl: process.argv[4] ?? null,
}).run();
