// scripts/storage-bench.mjs — measures the browser chunk store (PackedChunkStore, the real
// library class) in headless Chrome: write rate, the startup key scan, and the reads one
// mining step makes. Its numbers feed the page's sizing estimates (StorageSizing).
// Run: node scripts/storage-bench.mjs [chunkCount=2000] [profileDirectory]
// A profileDirectory on another disk (a USB drive, say) measures that disk. KEEP_DATA=1
// keeps the chunks; READ_ONLY=1 then reads them without writing, e.g. after the system's
// file cache is dropped (Linux: sync; echo 3 > /proc/sys/vm/drop_caches) to time cold reads.

import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

class StorageBench {
  static REPOSITORY = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  static ADDRESS = 'benchAddress';
  static CHUNK_BYTES = 262144;
  static WRITE_BATCH = 64;
  // One mining step reads 10 chunk pairs (both recall ranges), one pair at a time.
  static STEP_CHUNK_PAIRS = 10;
  static STEPS_SAMPLED = 50;
  // A fixed port: IndexedDB belongs to the origin, port included, so a READ_ONLY run must
  // use the same one as the run that wrote.
  static PORT = 47815;

  constructor({ chunkCount, profileDirectory }) {
    Object.assign(this, { chunkCount, profileDirectory });
  }

  /** Serves the repository over HTTP, so the page can import the library's modules. */
  async startServer() {
    this.server = createServer(async (request, response) => {
      const filePath = path.join(StorageBench.REPOSITORY, decodeURIComponent(new URL(request.url, 'http://x').pathname));
      try {
        const body = await readFile(filePath);
        response.writeHead(200, { 'content-type': filePath.endsWith('.js') ? 'text/javascript' : 'text/html' });
        response.end(body);
      } catch (error) {
        response.writeHead(404);
        response.end(String(error));
      }
    });
    await new Promise((resolve) => this.server.listen(StorageBench.PORT, '127.0.0.1', resolve));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  async run() {
    const origin = await this.startServer();
    const profile = this.profileDirectory ?? await mkdtemp(path.join(tmpdir(), 'storage-bench-'));
    const context = await chromium.launchPersistentContext(profile, { executablePath: '/usr/bin/google-chrome', headless: true });
    try {
      const page = await context.newPage();
      page.on('console', (message) => console.log('page:', message.text()));
      await page.goto(`${origin}/package.json`);
      const results = await page.evaluate(StorageBench.measureInPage, { ...StorageBench.settings(), chunkCount: this.chunkCount, keepData: Boolean(process.env.KEEP_DATA), readOnly: Boolean(process.env.READ_ONLY) });
      console.log(JSON.stringify({ profile, ...results }, null, 2));
    } finally {
      await context.close();
      this.server.close();
    }
  }

  static settings() {
    const { ADDRESS, CHUNK_BYTES, WRITE_BATCH, STEP_CHUNK_PAIRS, STEPS_SAMPLED } = StorageBench;
    return { address: ADDRESS, chunkBytes: CHUNK_BYTES, writeBatch: WRITE_BATCH, stepChunkPairs: STEP_CHUNK_PAIRS, stepsSampled: STEPS_SAMPLED };
  }

  /** Runs inside the page: everything it needs comes in `settings`. */
  static async measureInPage({ keepData, readOnly, address, chunkCount, chunkBytes, writeBatch, stepChunkPairs, stepsSampled }) {
    const { PackedChunkStore } = await import('/src/storage/chunk-store.js');
    const store = new PackedChunkStore({ log: console.log });
    if (!readOnly) await store.deleteAddress(address);
    // Random bytes, as packed chunks are, so no layer can compress them.
    const chunk = new Uint8Array(chunkBytes);
    for (let start = 0; start < chunkBytes; start += 65536) crypto.getRandomValues(chunk.subarray(start, start + 65536));

    let started = performance.now();
    for (let first = 0; !readOnly && first < chunkCount; first += writeBatch) {
      const entries = [];
      for (let index = first; index < Math.min(chunkCount, first + writeBatch); index++) entries.push([BigInt(index + 1) * BigInt(chunkBytes), chunk]);
      await store.save(address, entries);
    }
    const writeSeconds = (performance.now() - started) / 1000;

    started = performance.now();
    const listed = await store.listAllKeys();
    const keyScanMs = performance.now() - started;

    // Startup as the page does it: a fresh store reads the saved index, not every key.
    started = performance.now();
    const freshStore = new PackedChunkStore({ log: console.log });
    const indexed = await freshStore.savedIndex(address);
    const indexLoadMs = performance.now() - started;
    const offsets = await store.offsets(address);
    if (offsets.length < chunkCount || indexed.buckets.size + indexed.unalignedEnds.size < chunkCount || listed.length < chunkCount) {
      throw new Error(`only ${offsets.length} of ${chunkCount} chunks are indexed (${listed.length} keys listed)`);
    }

    // Data saved before the index existed: with the index gone, a fresh store lists the keys once and indexes them.
    await Promise.all([store.index.close(), freshStore.index.close()]);
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('weave-tab-miner-index');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('deleting the index was blocked by an open connection'));
    });
    const rebuilt = await new PackedChunkStore({ log: console.log }).savedIndex(address);
    if (rebuilt.buckets.size + rebuilt.unalignedEnds.size !== indexed.buckets.size + indexed.unalignedEnds.size) throw new Error('rebuilding the index lost chunks');

    // A step: 10 pairs, each pair read together, the next only after the last (as the miner does).
    const stepMs = [];
    for (let step = 0; step < stepsSampled; step++) {
      const stepStarted = performance.now();
      const range1 = Math.floor(Math.random() * (chunkCount - stepChunkPairs));
      const range2 = Math.floor(Math.random() * (chunkCount - stepChunkPairs));
      for (let pair = 0; pair < stepChunkPairs; pair++) {
        const read = await Promise.all([range1 + pair, range2 + pair].map((index) => store.loadOne(address, offsets[index])));
        if (read.some((bytes) => bytes?.length !== chunkBytes)) throw new Error('a stored chunk did not read back whole');
      }
      stepMs.push(performance.now() - stepStarted);
    }
    stepMs.sort((left, right) => left - right);
    if (!keepData) await store.deleteAddress(address);
    return {
      chunkCount,
      writeMiBPerSecond: readOnly ? null : +(chunkCount * chunkBytes / 2 ** 20 / writeSeconds).toFixed(1),
      keyScanMicrosecondsPerChunk: +(keyScanMs * 1000 / listed.length).toFixed(2),
      indexLoadMs: +indexLoadMs.toFixed(1),
      stepReadMsMedian: +stepMs[Math.floor(stepMs.length / 2)].toFixed(1),
      stepReadMsSlowest: +stepMs[stepMs.length - 1].toFixed(1),
    };
  }
}

const [chunkCount = '2000', profileDirectory] = process.argv.slice(2);
await new StorageBench({ chunkCount: Number(chunkCount), profileDirectory }).run();
