// test/step-sources.test.mjs — the three step sources and the mining loop, with stand-ins
// and intervals scaled down to milliseconds. Run: node test/step-sources.test.mjs
import { ReplayStepSource, ServerStepSource, ComputedStepSource, StepMiningLoop } from '../src/mining/step-sources.js';
import { TestCase } from './test-case.mjs';

class StepSourcesTest extends TestCase {
  /** A loop over `source` that records each mined step as "label:stepNumber". */
  static recordingLoop(source, { stopAfter = Infinity } = {}) {
    const mined = [];
    const loop = new StepMiningLoop({
      source,
      mineStep: async (stepNumber, output, label) => {
        mined.push(`${label}:${stepNumber}`);
        if (mined.length >= stopAfter) loop.stop();
      },
    });
    return { loop, mined };
  }

  async run() {
    const output = new Uint8Array(32);

    const replay = StepSourcesTest.recordingLoop(new ReplayStepSource({ steps: [[1, output], [2, output], [3, output]], intervalMs: 1 }));
    this.report('replay gives each step in turn, then finishes', (await replay.loop.run()).ended === 'finished' && replay.mined.join() === 'block:1,block:2,block:3');

    // A pool whose newest step moves on by 10 each poll: the first poll keeps the newest 8.
    let newestStep = 20;
    const pool = {
      poll: async (afterStep) => {
        const fresh = [];
        for (let step = Math.max(afterStep + 1, 1); step <= newestStep; step++) fresh.push([step, output]);
        newestStep += 10;
        return { newest: { stepNumber: newestStep }, newestFrom: 'http://vdf.example', fresh, gapFilled: false, missing: 0 };
      },
    };
    let lastMined = -1;
    const polls = [];
    const server = new ServerStepSource({ pool, lastMinedStep: () => lastMined, pollIntervalMs: 1, maxBacklog: 8, onPoll: (poll) => polls.push(poll) });
    const serverLoop = new StepMiningLoop({ source: server, mineStep: async (stepNumber) => { lastMined = stepNumber; if (stepNumber >= 30) serverLoop.stop(); } });
    this.report('server steps stop on request', (await serverLoop.run()).ended === 'stopped');
    this.report('the first poll keeps the newest 8 and counts none skipped (mining had not begun)', polls[0].skipped === 0 && lastMined >= 30, JSON.stringify(polls.map((poll) => poll.skipped)));
    this.report('later polls give only steps after the last mined', polls.length >= 2 && polls[1].skipped === 2, JSON.stringify(polls.map((poll) => poll.skipped)));

    const errors = [];
    let failOnce = true;
    const flaky = { poll: async (afterStep) => { if (failOnce) { failOnce = false; throw new Error('server down'); } return pool.poll(afterStep); } };
    const flakyLoop = StepSourcesTest.recordingLoop(new ServerStepSource({ pool: flaky, lastMinedStep: () => -1, pollIntervalMs: 1, onError: (error) => errors.push(error.message) }), { stopAfter: 1 });
    this.report('a failed poll is reported and polling goes on', (await flakyLoop.loop.run()).ended === 'stopped' && errors.join() === 'server down' && flakyLoop.mined.length === 1);

    const requests = [];
    const computed = new ComputedStepSource({
      start: { stepNumber: 100, output },
      computeStep: async ({ stepNumber }) => ({ stepNumber, output, checkpoints: [], seconds: 0.5 }),
      onRequest: (stepNumber, lastSeconds) => requests.push(`${stepNumber}/${lastSeconds}`),
    });
    const computedLoop = StepSourcesTest.recordingLoop(computed, { stopAfter: 3 });
    await computedLoop.loop.run();
    this.report('computed steps follow on from the start', computedLoop.mined.join() === 'this tab:101,this tab:102,this tab:103');
    this.report('each next step is requested before this one is mined', requests.slice(0, 3).join() === '101/null,102/0.5,103/0.5', requests.join());

    const broken = new ComputedStepSource({ start: { stepNumber: 1, output }, computeStep: async () => { throw new Error('worker failed'); } });
    const brokenRun = await new StepMiningLoop({ source: broken, mineStep: async () => {} }).run();
    this.report('a source that throws ends the loop as failed, with its error', brokenRun.ended === 'failed' && brokenRun.error.message === 'worker failed');
    this.finish();
  }
}

await new StepSourcesTest().run();
