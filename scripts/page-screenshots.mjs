// scripts/page-screenshots.mjs — full-page screenshots of the built page at desktop and phone widths,
// for reviewing it as a newcomer would first see it. Writes PNGs into the given directory.
// Run: node scripts/page-screenshots.mjs [output directory]   (default: ./screenshots)
// PLAYWRIGHT_CHANNEL=chrome uses an installed Chrome instead of Playwright's own.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

class PageScreenshots {
  static VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };

  constructor(outputDirectory) {
    this.outputDirectory = outputDirectory;
  }

  async run() {
    const { chromium } = createRequire(import.meta.url)('playwright-core');
    mkdirSync(this.outputDirectory, { recursive: true });
    const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
    const url = pathToFileURL(resolve('dist/weave-tab-miner.html')).href;
    for (const [name, viewport] of Object.entries(PageScreenshots.VIEWPORTS)) {
      const page = await browser.newPage({ viewport });
      await page.goto(url);
      await page.waitForFunction(() => /ready:/.test(document.getElementById('activityLog')?.textContent ?? ''), null, { timeout: 120000 });
      // The first screenful is what a newcomer judges the page by; the full page shows the rest.
      await page.screenshot({ path: `${this.outputDirectory}/${name}-first-screen.png` });
      await page.screenshot({ path: `${this.outputDirectory}/${name}-full.png`, fullPage: true });
      console.log(`${name}: page height ${await page.evaluate(() => document.body.scrollHeight)} px`);
      await page.close();
    }
    await browser.close();
  }
}

await new PageScreenshots(process.argv[2] ?? 'screenshots').run();
