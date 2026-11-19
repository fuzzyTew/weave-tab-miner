// test/chunk-fetcher.test.mjs — checks ChunkFetcher against a fake gateway with random
// delays (scaled down to milliseconds) and missing chunks: it delivers exactly the chunks
// wanted, never runs more requests at once than allowed, skips missing ones, batches as
// asked, and stops starting requests when told. Run: node test/chunk-fetcher.test.mjs
import { ChunkFetcher } from '../src/network/chunk-fetcher.js';
import { Bytes } from '../src/core/bytes.js';

class FakeGateway {
  /** Answers chunkJson after 1–5 ms; positions divisible by `missingEvery` have no chunk. */
  constructor({ missingEvery = 7 } = {}) {
    Object.assign(this, { missingEvery, inFlight: 0, mostInFlight: 0, requests: 0 });
  }

  async chunkJson(weaveByte) {
    this.requests++;
    this.inFlight++;
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1 + Math.random() * 4));
    this.inFlight--;
    if (weaveByte % BigInt(this.missingEvery) === 0n) throw new Error('HTTP 404');
    return { chunk: Bytes.toBase64Url(new Uint8Array(16).fill(Number(weaveByte % 256n))) };
  }
}

class ChunkFetcherTest {
  constructor() {
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  async collect(fetcher, positions, options) {
    const batchSizes = [];
    const chunks = [];
    for await (const batch of fetcher.batches(positions, options)) {
      batchSizes.push(batch.length);
      chunks.push(...batch);
    }
    return { batchSizes, chunks };
  }

  async run() {
    const gateway = new FakeGateway({ missingEvery: 7 });
    const fetcher = new ChunkFetcher({ gateway, concurrency: 5 });
    let skipped = 0;
    let lastProgress = null;
    // Positions 1000·k + 1; those divisible by 7 are missing.
    const positions = (function* () { for (let index = 1n; index <= 400n; index++) yield index * 1000n + 1n; })();
    const { batchSizes, chunks } = await this.collect(fetcher, positions, { wanted: 100, batchSize: 30, onSkip: () => skipped++, onProgress: (progress) => { lastProgress = progress; } });
    this.report('delivers exactly the chunks wanted', chunks.length === 100, `${chunks.length} chunks, ${skipped} skipped`);
    this.report('never more requests at once than allowed', gateway.mostInFlight <= 5, `at most ${gateway.mostInFlight}`);
    this.report('skips missing chunks and takes others', skipped > 0 && gateway.requests === 100 + skipped, `${gateway.requests} requests`);
    this.report('hands back full batches, then the rest', batchSizes.slice(0, -1).every((size) => size === 30) && batchSizes.reduce((sum, size) => sum + size, 0) === 100, batchSizes.join(', '));
    this.report('progress counts what arrived', lastProgress.fetched === 100 && lastProgress.bytes === 1600, `${lastProgress.fetched} chunks, ${lastProgress.bytes} bytes`);

    const stopper = new AbortController();
    const stopGateway = new FakeGateway({ missingEvery: 1e9 });
    const stopping = await this.collect(new ChunkFetcher({ gateway: stopGateway, concurrency: 4 }), (function* () { for (let index = 1n; ; index++) yield index; })(), {
      wanted: 1000, batchSize: 10, signal: stopper.signal, onProgress: (progress) => { if (progress.fetched === 20) stopper.abort(); },
    });
    this.report('stopping starts no more requests', stopping.chunks.length < 30 && stopGateway.requests < 30, `${stopping.chunks.length} chunks after stopping at 20, ${stopGateway.requests} requests`);

    const short = await this.collect(new ChunkFetcher({ gateway: new FakeGateway({ missingEvery: 2 }), concurrency: 3 }), (function* () { for (let index = 1n; index <= 10n; index++) yield index; })(), { wanted: 50 });
    this.report('ends when positions run out', short.chunks.length === 5, `${short.chunks.length} of 50 wanted from 10 positions, half missing`);
    process.exitCode = this.failures ? 1 : 0;
  }
}

new ChunkFetcherTest().run();
