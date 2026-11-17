// randomx_worker.js — the body of a classic Web Worker running Arweave's RandomX.
// build_single_file.mjs places it after the RandomxArweave bundle (vendor/randomx-arweave)
// and the inlined library, which define RandomxArweave and RandomxRequests.
// Messages in:  { id, kind: 'init' | 'h0' | 'entropy', payload }
// Messages out: { id, result } or { id, error }

class RandomxWorker {
  /**
   * Builds the RandomX engine on 'init' and answers hash and entropy requests in order.
   */
  constructor() {
    this.engine = null;
  }

  handle(kind, payload) {
    if (kind === 'init') {
      this.engine = RandomxRequests.createEngine(RandomxArweave);
      return true;
    }
    if (!this.engine) throw new Error('RandomX worker used before init');
    if (kind === 'h0') return this.engine.h0(payload);
    if (kind === 'entropy') return this.engine.entropy(payload);
    throw new Error(`unknown request ${kind}`);
  }

  run() {
    self.onmessage = ({ data }) => {
      try {
        const result = this.handle(data.kind, data.payload);
        // Transfer large results (8 MiB entropies) instead of copying them.
        self.postMessage({ id: data.id, result }, result instanceof Uint8Array ? [result.buffer] : []);
      } catch (error) {
        self.postMessage({ id: data.id, error: error.message });
      }
    };
  }
}

new RandomxWorker().run();
