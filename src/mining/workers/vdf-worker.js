// src/mining/workers/vdf-worker.js — computes VDF steps off the page's main thread so the page stays responsive.
// Messages in:  { stepNumber, previousOutput (Uint8Array), iterationsPerCheckpoint, resetSeed (Uint8Array|null) }
//           or: { checkpointRequest: id, saltNumber (BigInt), input (Uint8Array), iterationsPerCheckpoint }
// Messages out: { stepNumber, output (Uint8Array), checkpoints (25, oldest first), seconds },
//               { checkpointRequest: id, output }, or { error } (with checkpointRequest when it was one)
import { VdfChain } from '../vdf.js';

class VdfWorker {
  /**
   * Holds one VdfChain per difficulty and answers one step request at a time.
   */
  constructor() {
    this.chain = null;
  }

  chainFor(iterationsPerCheckpoint) {
    if (!this.chain || this.chain.iterationsPerCheckpoint !== iterationsPerCheckpoint) {
      this.chain = new VdfChain({ iterationsPerCheckpoint });
    }
    return this.chain;
  }

  handle(request) {
    if (request.checkpointRequest !== undefined) {
      // One checkpoint, to spot-check a VDF server's step (VdfSpotCheck).
      const { checkpointRequest, saltNumber, input, iterationsPerCheckpoint } = request;
      return { checkpointRequest, output: this.chainFor(iterationsPerCheckpoint).computeCheckpoint(saltNumber, input) };
    }
    const { stepNumber, previousOutput, iterationsPerCheckpoint, resetSeed } = request;
    this.chainFor(iterationsPerCheckpoint);
    const started = performance.now();
    const checkpoints = this.chain.computeStep(stepNumber, previousOutput, resetSeed);
    // The checkpoints go back too (800 bytes): a block built on this step lists them.
    return { stepNumber, output: checkpoints.at(-1), checkpoints, seconds: (performance.now() - started) / 1000 };
  }

  run() {
    self.onmessage = (event) => {
      try {
        self.postMessage(this.handle(event.data));
      } catch (error) {
        self.postMessage({ checkpointRequest: event.data.checkpointRequest, error: `${error.name}: ${error.message}` });
      }
    };
  }
}

new VdfWorker().run();
