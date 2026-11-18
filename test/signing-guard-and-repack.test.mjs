// test/signing-guard-and-repack.test.mjs — DoubleSigningGuard against the node's rule, and
// ChunkPacker.repackChunks against packing the plain data directly (stand-in entropy, which
// exercises the same XOR logic quickly). Run: node test/signing-guard-and-repack.test.mjs
import { DoubleSigningGuard } from '../src/signing-guard.js';
import { Bytes, ChunkPacker, MiningIdentity, StubEntropySource } from '../src/miner.js';

class MapStorage {
  /** The getItem/setItem part of localStorage, in memory. */
  constructor() { this.items = new Map(); }
  getItem(key) { return this.items.get(key) ?? null; }
  setItem(key, value) { this.items.set(key, value); }
}

class GuardAndRepackTest {
  constructor() {
    this.failures = 0;
  }

  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  checkGuard() {
    const guard = new DoubleSigningGuard({ storage: new MapStorage() });
    const address = 'shared-key-address';
    const first = { height: 10, cumulativeDiff: 1000n, previousCumulativeDiff: 900n, blockHash: 'a' };
    this.report('first block is allowed', guard.conflictFor(address, first) === null);
    guard.record(address, first);
    this.report('the same block again is allowed', guard.conflictFor(address, first) === null);
    this.report('a rival at the same cumulative difficulty is refused', guard.conflictFor(address, { height: 10, cumulativeDiff: 1000n, previousCumulativeDiff: 900n, blockHash: 'b' }) !== null);
    this.report('a rival overlapping it is refused', guard.conflictFor(address, { height: 10, cumulativeDiff: 1050n, previousCumulativeDiff: 950n, blockHash: 'c' }) !== null);
    this.report('the next block, built on it, is allowed', guard.conflictFor(address, { height: 11, cumulativeDiff: 1100n, previousCumulativeDiff: 1000n, blockHash: 'd' }) === null);
    this.report('another address is unaffected', guard.conflictFor('other', { height: 10, cumulativeDiff: 1000n, previousCumulativeDiff: 900n, blockHash: 'b' }) === null);
  }

  async checkRepack() {
    const entropySource = new StubEntropySource();
    const from = MiningIdentity.fromAddress('wYnRY0GUYWkoisS45Djguy5DZ5Xt3z1bE0KDPnq66c4');
    const to = MiningIdentity.fromAddress('pFgmLdTSvnNplpTQDalbOpxWv9Wntk-swLLJK0U684M');
    const plain = [0, 1].map((index) => ({ endOffset: 40_000_000_000_000n + BigInt(index) * 262144n, bytes: new Uint8Array(262144).map((_, byte) => (byte * 7 + index) & 255) }));
    const packedForFrom = await new ChunkPacker(from, entropySource).packChunks(plain);
    const direct = await new ChunkPacker(to, entropySource).packChunks(plain);
    const repacked = await ChunkPacker.repackChunks({ entries: plain.map(({ endOffset }, index) => [endOffset, packedForFrom[index]]), fromIdentity: from, toIdentity: to, entropySource });
    this.report('repacking equals packing the plain data for the new address', repacked.every(([, bytes], index) => Bytes.equal(bytes, direct[index])));
    this.report('and differs from the old packing', !Bytes.equal(repacked[0][1], packedForFrom[0]));
  }

  async run() {
    this.checkGuard();
    await this.checkRepack();
    process.exitCode = this.failures ? 1 : 0;
  }
}

new GuardAndRepackTest().run();
