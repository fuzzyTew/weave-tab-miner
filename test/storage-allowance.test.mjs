// test/storage-allowance.test.mjs — StorageAllowance's rules: the usable share, Chrome's
// floating figure, typed amounts past it, and the chunk count to fetch.
// Run: node test/storage-allowance.test.mjs
import { StorageAllowance } from '../src/storage/storage-allowance.js';
import { TestCase } from './test-case.mjs';

class StorageAllowanceTest extends TestCase {
  static GiB = 2 ** 30;

  run() {
    const GiB = StorageAllowanceTest.GiB;
    const unknown = new StorageAllowance();
    this.report('nothing is known before the estimate', unknown.targetBytes === null && unknown.chunksToReach({ heldBytes: 0, heldChunkCount: 0 }) === 0);

    // Firefox-like: a real 8 GiB limit (a tenth of an 80 GiB disk) caps a larger setting
    // at the usable 90%, in whole 64 MiB steps: 115 steps.
    const firefox = new StorageAllowance({ estimate: { quota: 8 * GiB, usage: GiB }, setting: 14 * GiB });
    this.report('a real limit is not floating', !firefox.quotaFloats);
    this.report('a real limit caps a set amount at the usable share', firefox.targetBytes === 115 * StorageAllowance.STEP_BYTES, String(firefox.targetBytes / GiB));

    // Chrome: usage + 10 GiB floats, so 14 GiB typed is honoured.
    const chrome = new StorageAllowance({ estimate: { quota: 13 * GiB, usage: 3 * GiB }, setting: 14 * GiB });
    this.report("Chrome's usage-plus-10-GiB figure floats", chrome.quotaFloats);
    this.report('a floating figure honours 14 GiB', chrome.targetBytes === 14 * GiB);

    chrome.setting = 'max';
    this.report('"max" is the usable share in whole steps', chrome.targetBytes % StorageAllowance.STEP_BYTES === 0 && chrome.targetBytes <= 13 * GiB * 0.9);
    this.report('a slider at the usable share picks "max"', chrome.settingForPosition(chrome.usableBytes) === 'max' && chrome.settingForPosition(GiB) === GiB);
    this.report('saved text parses', StorageAllowance.parseSetting('1073741824') === GiB && StorageAllowance.parseSetting(null) === 'max');
    this.report('typed amounts round to steps', StorageAllowance.roundedToStep(1.01 * GiB) === GiB && StorageAllowance.roundedToStep(1) === StorageAllowance.STEP_BYTES);

    const small = new StorageAllowance({ estimate: { quota: 10 * GiB, usage: 0 }, setting: 2 ** 20 });
    this.report('chunks to reach 1 MiB from empty is 4', small.chunksToReach({ heldBytes: 0, heldChunkCount: 0 }) === 4);
    this.report('a chunk limit caps the count', small.chunksToReach({ heldBytes: 0, heldChunkCount: 0, chunkLimit: 1 }) === 1);
    this.report('over the target is 0', small.chunksToReach({ heldBytes: 2 ** 21, heldChunkCount: 8 }) === 0);
    this.finish();
  }
}

new StorageAllowanceTest().run();
