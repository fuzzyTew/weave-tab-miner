// test/bucket-set.test.mjs — BucketSet against a plain Set over random members, across page
// borders. Run: node test/bucket-set.test.mjs
import { BucketSet } from '../src/mining/bucket-set.js';
import { TestCase } from './test-case.mjs';

class BucketSetTest extends TestCase {
  run() {
    const set = new BucketSet();
    const reference = new Set();
    // A seeded generator (xorshift) so a failure repeats exactly from run to run.
    let state = 0x9e3779b9;
    const nextRandom = () => {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      return (state >>> 0) / 2 ** 32;
    };
    const span = BucketSet.PAGE_BITS * 3;
    let addsAgreed = true;
    for (let index = 0; index < 20_000; index++) {
      const member = Math.floor(nextRandom() * span);
      addsAgreed &&= set.add(member) === !reference.has(member);
      reference.add(member);
    }
    const sorted = [...reference].sort((left, right) => left - right);
    this.report('add says whether a member is new', addsAgreed);
    this.report('size matches', set.size === reference.size);
    this.report('ascending lists every member in order', [...set.ascending()].join() === sorted.join());
    const low = BucketSet.PAGE_BITS - 1000;
    const high = BucketSet.PAGE_BITS * 2 + 1000;
    this.report('a range across page borders', [...set.ascending(low, high)].join() === sorted.filter((member) => member >= low && member < high).join());
    this.report('has agrees everywhere sampled', sorted.slice(0, 500).every((member) => set.has(member)) && !set.has(span + 5));
    const rebuilt = BucketSet.fromPages(set.pagesForSaving());
    this.report('rebuilt from its pages, it is the same set', rebuilt.size === set.size && [...rebuilt.ascending()].join() === sorted.join());
    this.finish();
  }
}

new BucketSetTest().run();
