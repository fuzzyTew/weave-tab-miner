// test/data-item.test.mjs — checks ANS-104 data items against one made by @dha-team/arbundles
// (test/fixtures/data-item.json): ours must verify its signature, derive the same id, and lay out
// every unsigned byte the same way. Run: node test/data-item.test.mjs
import { readFileSync } from 'node:fs';
import { Bytes } from '../src/core/bytes.js';
import { DataItem } from '../src/wallet/bundle.js';

class DataItemTest {
  run() {
    return this.check().then((failures) => { process.exitCode = failures ? 1 : 0; });
  }

  async check() {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/data-item.json', import.meta.url), 'utf8'));
    const referenceBytes = Uint8Array.from(Buffer.from(fixture.base64, 'base64'));
    let failures = 0;
    const report = (name, passed, detail = '') => {
      if (!passed) failures++;
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    };

    const parsed = await DataItem.parseAndVerify(referenceBytes);
    report('arbundles item verifies', parsed.valid);
    report('id is SHA-256 of the signature', parsed.id === fixture.id, parsed.id);
    report('data reads back', new TextDecoder().decode(parsed.data) === fixture.dataText);

    // Rebuild the same item with our serializer, reusing the reference signature and owner.
    const ours = new DataItem({ data: new TextEncoder().encode(fixture.dataText), tags: fixture.tags, anchor: new Uint8Array(32).fill(fixture.anchorByte) });
    ours.signature = referenceBytes.subarray(2, 2 + 512);
    ours.ownerBytes = referenceBytes.subarray(2 + 512, 2 + 1024);
    report('our serialization matches byte for byte', Bytes.toHex(ours.toBytes()) === Bytes.toHex(referenceBytes), `${referenceBytes.length} bytes`);

    const tampered = referenceBytes.slice();
    tampered[tampered.length - 1] ^= 1;
    report('a changed byte fails verification', !(await DataItem.parseAndVerify(tampered)).valid);
    return failures;
  }
}

new DataItemTest().run();
