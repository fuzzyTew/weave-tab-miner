// test/storage-archive.test.mjs — round-trips packed chunks through PackedChunkArchive and
// checks that damaged or foreign files are refused. Run: node test/storage-archive.test.mjs
import { PackedChunkArchive } from '../src/storage/chunk-store.js';

class ArchiveTest {
  async run() {
    let failures = 0;
    const report = (name, passed, detail = '') => {
      if (!passed) failures++;
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    };
    const address = 'wYnRY0GUYWkoisS45Djguy5DZ5Xt3z1bE0KDPnq66c4';
    const entries = [3n, 7n, 123456789012345n].map((offset, index) => [offset, new Uint8Array(PackedChunkArchive.CHUNK_SIZE).fill(index + 1)]);
    const blob = PackedChunkArchive.toBlob(address, entries);
    const back = await PackedChunkArchive.fromBlob(blob);
    report('address comes back', back.address === address);
    report('offsets and bytes come back', back.entries.length === 3 && back.entries.every(([offset, chunk], index) => offset === entries[index][0] && chunk.every((byte) => byte === index + 1)), `${blob.size} bytes`);
    const truncated = await PackedChunkArchive.fromBlob(blob.slice(0, blob.size - 1)).then(() => 'accepted', (error) => error.message);
    report('a truncated file is refused', truncated !== 'accepted', truncated);
    const foreign = await PackedChunkArchive.fromBlob(new Blob(['hello\nworld\n'])).then(() => 'accepted', (error) => error.message);
    report('another file is refused', foreign !== 'accepted', foreign);
    report('file name names the address and count', PackedChunkArchive.fileName(address, 3) === 'weave-chunks-wYnRY0GU-3.bin');

    // Streamed in batches of 2 from a store-like reader, and read back in batches of 2: the
    // same bytes as building it whole, without holding it whole either way.
    const stored = new Map(entries.map(([offset, chunk]) => [String(offset), chunk]));
    const parts = [];
    let progress = '';
    for await (const part of PackedChunkArchive.parts(address, entries.map(([offset]) => offset), async (offsets) => offsets.map((offset) => [offset, stored.get(String(offset))]), { batchSize: 2, onProgress: (done, total) => { progress += `${done}/${total} `; } })) parts.push(part);
    const streamed = new Blob(parts);
    const same = Buffer.from(await streamed.arrayBuffer()).equals(Buffer.from(await blob.arrayBuffer()));
    const batchSizes = [];
    for await (const batch of PackedChunkArchive.batches(streamed, { batchSize: 2 })) batchSizes.push(batch.entries.length);
    report('streaming an archive in batches gives the same file, and reads back in batches', same && batchSizes.join() === '2,1' && progress.trim() === '2/3 3/3', `batches ${batchSizes.join()}; progress ${progress.trim()}`);
    let missing = 'accepted';
    try {
      for await (const part of PackedChunkArchive.parts(address, [1n], async () => [])) void part;
    } catch (error) {
      missing = error.message;
    }
    report('a chunk missing from storage stops the export with its offset', /chunk at 1 is missing/.test(missing), missing);
    process.exitCode = failures ? 1 : 0;
  }
}

new ArchiveTest().run();
