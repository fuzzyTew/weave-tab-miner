// Checks the GET /vdf parser on an update built byte-for-byte to the layout in
// ar_serialize.erl (nonce_limiter_update_to_binary format 2). No live VDF server was
// reachable when this was written, so this tests the layout, not a real server's reply.
// Run: node test/vdf-update.test.mjs
import { Bytes } from '../src/core/bytes.js';
import { VdfUpdate } from '../src/network/vdf-client.js';

class VdfUpdateTest {
  static encodeInt(value) {
    if (value === 0n) return new Uint8Array([0]);
    let hex = value.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const bytes = Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
    return Bytes.concat(new Uint8Array([bytes.length]), bytes);
  }

  static filled(length, value) {
    return new Uint8Array(length).fill(value);
  }

  run() {
    const steps = [VdfUpdateTest.filled(32, 3), VdfUpdateTest.filled(32, 2), VdfUpdateTest.filled(32, 1)];
    const checkpoints = Array.from({ length: 25 }, (_, index) => VdfUpdateTest.filled(32, 100 + index));
    const body = Bytes.concat(
      VdfUpdateTest.filled(48, 7),                      // NextSeed:48/binary
      VdfUpdateTest.encodeInt(1_134_000n),               // encode_int(NextVDFDifficulty, 8)
      Bytes.fromBigInt(1200n, 8),                        // Interval:64
      new Uint8Array([0]),                               // IsPartial
      Bytes.fromBigInt(25n, 2), ...checkpoints,          // CheckpointLen:16, checkpoints
      Bytes.fromBigInt(119_924_200n, 8),                 // StepNumber:64
      VdfUpdateTest.filled(48, 9),                       // Seed:48/binary
      VdfUpdateTest.encodeInt(393_022_109_425_910n),     // encode_int(UpperBound, 8)
      VdfUpdateTest.encodeInt(393_100_000_000_000n),     // encode_int(NextUpperBound, 8)
      Bytes.fromBigInt(3n, 2), ...steps,                 // StepsLen:16, steps
    );
    const update = VdfUpdate.parse(body);
    const fresh = VdfUpdate.steps(update, 119_924_198);
    const checks = [
      ['step number', update.stepNumber === 119_924_200],
      ['difficulty', update.nextVdfDifficulty === 1_134_000n],
      ['upper bound', update.upperBound === 393_022_109_425_910n],
      ['25 checkpoints', update.checkpoints.length === 25 && update.checkpoints[24][0] === 124],
      ['newer steps, oldest first', fresh.length === 2 && fresh[0][0] === 119_924_199 && fresh[0][1][0] === 2 && fresh[1][1][0] === 3],
    ];
    let failures = 0;
    for (const [name, passed] of checks) {
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
      if (!passed) failures++;
    }
    let threw = false;
    try { VdfUpdate.parse(body.subarray(0, 100)); } catch { threw = true; }
    console.log(`${threw ? 'PASS' : 'FAIL'}  truncated update is refused`);
    process.exitCode = failures === 0 && threw ? 0 : 1;
  }
}

new VdfUpdateTest().run();
