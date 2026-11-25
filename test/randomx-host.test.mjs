// test/randomx-host.test.mjs — RandomxWorkerHost with a stand-in worker: one request at a
// time reaches the worker, and an H0 asked for during a packing batch is sent next, ahead
// of the entropies still waiting. Run: node test/randomx-host.test.mjs
import { RandomxWorkerHost } from '../src/mining/randomx.js';
import { TestCase } from './test-case.mjs';

/** Records what is sent and answers when told to, as a worker would one message at a time. */
class StandInWorker {
  sent = [];
  onmessage = null;
  onerror = null;

  postMessage(message) {
    this.sent.push(message);
  }

  /** Answers the oldest unanswered message. */
  answerNext() {
    const message = this.sent.find((sent) => !sent.answered);
    message.answered = true;
    this.onmessage({ data: { id: message.id, result: `${message.kind}:${message.payload ?? ''}` } });
  }
}

class RandomxHostTest extends TestCase {
  async run() {
    const worker = new StandInWorker();
    const host = new RandomxWorkerHost(() => worker);
    worker.answerNext(); // init
    await host.ready();

    const entropies = [1, 2, 3].map((key) => host.entropy(key));
    await Promise.resolve();
    this.report('only one request is in the worker at a time', worker.sent.filter((message) => !message.answered).length === 1);

    const h0 = host.h0('step');
    await Promise.resolve();
    worker.answerNext(); // entropy 1 finishes
    this.report('an H0 asked for during packing goes next, ahead of waiting entropies', worker.sent.at(-1).kind === 'h0');
    worker.answerNext();
    this.report('the H0 is answered', (await h0) === 'h0:step');
    worker.answerNext();
    worker.answerNext();
    this.report('the entropies all finish after it, in order', (await Promise.all(entropies)).join() === 'entropy:1,entropy:2,entropy:3' && host.queuedCount === 0);
    this.finish();
  }
}

await new RandomxHostTest().run();
