// test/file-result-store.mjs — keeps RandomX results (replica 2.9 entropies, H0 hashes) in
// files between test runs (the `store` of RandomxSquaredEntropySource and RandomxH0Hasher),
// so tests replaying the same blocks skip seconds of RandomX each. Node only.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import { RandomxDirectHost, RandomxH0Hasher, RandomxSquaredEntropySource } from '../src/mining/randomx.js';

export class FileResultStore {
  /**
   * Results under `.cache/<kind>/<fingerprint>/<key hex>`. The fingerprint hashes the
   * code that computes them (the RandomX build and src/mining/randomx.js), so a change
   * there computes them afresh rather than trusting old results: a cache can only skip
   * work the current code would repeat exactly. CI keeps the folder with actions/cache.
   */
  static ROOT = new URL('../.cache/', import.meta.url);
  static FINGERPRINTED_FILES = ['../vendor/randomx-arweave/randomx-arweave.iife.js', '../src/mining/randomx.js'];

  /** `kind` names the folder: 'entropy' or 'h0'. */
  constructor({ kind }) {
    const fingerprint = createHash('sha256');
    for (const file of FileResultStore.FINGERPRINTED_FILES) fingerprint.update(readFileSync(new URL(file, import.meta.url)));
    this.directory = path.join(FileResultStore.ROOT.pathname, kind, fingerprint.digest('hex').slice(0, 16));
    mkdirSync(this.directory, { recursive: true });
    this.hits = 0;
    this.misses = 0;
  }

  async get(keyHex) {
    const file = path.join(this.directory, keyHex);
    if (!existsSync(file)) {
      this.misses++;
      return null;
    }
    this.hits++;
    return new Uint8Array(readFileSync(file));
  }

  /** Written to a temporary name first, so a stopped run never leaves half a result. */
  async set(keyHex, result) {
    const file = path.join(this.directory, keyHex);
    writeFileSync(`${file}.partial`, result);
    renameSync(`${file}.partial`, file);
  }
}

export class StoredRandomx {
  /**
   * Real RandomX for tests that replay blocks, with results kept in FileResultStores, so a
   * repeat run skips RandomX entirely (the engine is made only when a result is missing).
   * test/randomx-against-block.test.mjs keeps computing RandomX itself, uncached, so the
   * computation stays checked on every run.
   */
  static create() {
    // The bundle is a classic script defining RandomxArweave; evaluate it as a page would.
    runInThisContext(readFileSync(new URL('../vendor/randomx-arweave/randomx-arweave.iife.js', import.meta.url), 'utf8') + '\nglobalThis.RandomxArweave = RandomxArweave;');
    const host = new RandomxDirectHost(globalThis.RandomxArweave);
    return {
      host,
      h0Hasher: new RandomxH0Hasher(host, { store: new FileResultStore({ kind: 'h0' }) }),
      entropySource: new RandomxSquaredEntropySource(host, { store: new FileResultStore({ kind: 'entropy' }) }),
    };
  }
}
