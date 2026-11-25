// Checks the GET /vdf parser on an update built byte-for-byte to the layout in
// ar_serialize.erl (nonce_limiter_update_to_binary format 2). No live VDF server was
// reachable when this was written, so this tests the layout, not a real server's reply.
// Run: node test/vdf-update.test.mjs
import { Bytes } from '../src/core/bytes.js';
import { VdfServerPool, VdfStepRecord, VdfUpdate } from '../src/network/vdf-client.js';
import { VdfSession } from '../src/mining/vdf.js';

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

  async run() {
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
      ['a session moved onto the update takes its bound but keeps the tip block\'s seed, as H0 must', (() => {
        const moved = new VdfSession({ seed: new Uint8Array(48), nextSeed: new Uint8Array(48), partitionUpperBound: 1n, networkDiff: 5n, height: 7 }).withVdfUpdate(update);
        return moved.seed[0] === 0 && moved.partitionUpperBound === 393_022_109_425_910n && moved.networkDiff === 5n && moved.height === 7;
      })()],
      ['a step record merges updates and lists the steps after one, oldest first', (() => {
        const record = new VdfStepRecord();
        record.add(update);
        record.add({ ...update, stepNumber: 119_924_202, stepsNewestFirst: [update.stepsNewestFirst[0]], checkpoints: [] });
        const after = record.stepsAfter(119_924_199).map(([step]) => step);
        return record.newestStep === 119_924_202 && after.join() === '119924200,119924202' && record.missingSteps(119_924_199, 119_924_202).join() === '119924201';
      })()],
      ['a step computed here is kept with its checkpoints, the last being its output', (() => {
        const record = new VdfStepRecord();
        const checkpoints = Array.from({ length: 25 }, (_, index) => new Uint8Array(32).fill(index));
        record.addComputedStep(7, checkpoints);
        return record.outputsByStep.get(7)[0] === 24 && record.checkpointsByStep.get(7) === checkpoints;
      })()],
      ['newer steps, oldest first', fresh.length === 2 && fresh[0][0] === 119_924_199 && fresh[0][1][0] === 2 && fresh[1][1][0] === 3],
    ];
    // Two servers at different paces, the faster one with a gap since the last mined step.
    const step = (number) => new Uint8Array(32).fill(number % 256);
    const updateAt = (number) => ({ ...update, stepNumber: number, stepsNewestFirst: [step(number), step(number - 1)], checkpoints: [] });
    const sessionTo = (number) => ({ ...update, stepNumber: number, stepsNewestFirst: Array.from({ length: 10 }, (_, index) => step(number - index)), checkpoints: [] });
    const slow = { serverUrl: 'slow', latest: async () => updateAt(105), session: async () => sessionTo(105) };
    const fast = { serverUrl: 'fast', latest: async () => updateAt(110), session: async () => sessionTo(110) };
    const pool = new VdfServerPool({ clients: [slow, fast] });
    const round = await pool.poll(103);
    checks.push(['a server pool follows the newest server, fills the gap from its session, and lists every step after the last mined',
      round.newest.stepNumber === 110 && round.gapFilled && round.missing === 0 && round.fresh.map(([number]) => number).join() === '104,105,106,107,108,109,110']);
    const failing = new VdfServerPool({ clients: [{ serverUrl: 'down', latest: async () => { throw new Error('refused'); } }] });
    checks.push(['a pool with no server answering says why', await failing.poll(1).then(() => false, (error) => /down: refused/.test(error.message))]);

    const unreachable = await VdfServerPool.connect(['http://127.0.0.1:9'], { timeoutMs: 2000 });
    checks.push(['connecting to no answering server gives no pool and each one\'s reason', unreachable.pool === null && unreachable.failures.length === 1 && /could not connect/.test(unreachable.failures[0].reason)]);

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
