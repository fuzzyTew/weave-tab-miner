// src/randomx.js — Arweave's two RandomX uses, run through randomx.js built for Arweave
// (vendor/randomx-arweave): H0, and the replica 2.9 packing entropy ("RandomX squared").
// Both share one 512 MiB RandomX cache keyed by RANDOMX_PACKING_KEY.
import { Sha256 } from './miner.js';

export class RandomxRequests {
  /**
   * The operations a RandomX host performs, shared by the worker and the direct host so
   * both sides agree on names. Cache: built once from the packing key
   * (include/ar_consensus.hrl RANDOMX_PACKING_KEY; ar_packing_server.erl init state).
   */
  static PACKING_KEY = 'default arweave 2.5 pack key';
  static LANE_COUNT = 4; // REPLICA_2_9_RANDOMX_LANE_COUNT

  /** rsp_fused_entropy lane seeds: SHA-256(entropy key || byte(lane + 1)) (randomx_squared.cpp). */
  static laneSeeds(entropyKey) {
    return Array.from({ length: RandomxRequests.LANE_COUNT }, (_, lane) => Sha256.hash(entropyKey, new Uint8Array([lane + 1])));
  }

  /** Runs inside whichever context loaded the RandomxArweave bundle. */
  static createEngine(RandomxArweave) {
    let cache;
    try {
      cache = RandomxArweave.randomx_init_cache(RandomxRequests.PACKING_KEY);
    } catch (error) {
      // A 32-bit browser, or one low on memory, refuses the 512 MiB cache here.
      throw new Error(`could not allocate the 512 MiB RandomX cache (${error.message}). Real H0 and packing need it; a 64-bit browser with free memory should work`);
    }
    const hashVm = RandomxArweave.randomx_create_vm(cache);
    const entropyVm = RandomxArweave.randomx_create_rx2(cache);
    return {
      h0: (preimage) => hashVm.calculate_hash(preimage),
      entropy: (entropyKey) => entropyVm.fused_entropy(RandomxRequests.laneSeeds(entropyKey)),
    };
  }
}

export class RandomxWorkerHost {
  /**
   * Runs RandomX in a Web Worker so cache building (seconds) and entropy (about a second
   * each) never freeze the page. `createWorker` returns a Worker running
   * src/workers/randomx-worker.js (or its inlined copy in the single-file build).
   */
  constructor(createWorker) {
    this.worker = createWorker();
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      const error = new Error(`RandomX worker failed: ${event.message || 'no reason given'}`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    this.readyPromise = this.call('init');
  }

  call(kind, payload) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, kind, payload });
    });
  }

  ready() {
    return this.readyPromise;
  }

  async h0(preimage) {
    await this.readyPromise;
    return this.call('h0', preimage);
  }

  async entropy(entropyKey) {
    await this.readyPromise;
    return this.call('entropy', entropyKey);
  }
}

export class RandomxDirectHost {
  /**
   * The same interface without a worker, for Node (server mode, tests). Blocks while it works.
   */
  constructor(RandomxArweave) {
    this.engine = RandomxRequests.createEngine(RandomxArweave);
  }

  async ready() {}

  async h0(preimage) {
    return this.engine.h0(preimage);
  }

  async entropy(entropyKey) {
    return this.engine.entropy(entropyKey);
  }
}

export class RandomxBundle {
  /**
   * Loads vendor/randomx-arweave/randomx-arweave.iife.js from its text. It is a classic
   * script defining RandomxArweave; indirect eval runs it in global scope, as a <script>
   * tag would, and returns that value.
   */
  static fromText(bundleText) {
    return (0, eval)(`${bundleText}\n;RandomxArweave`);
  }
}

export class RandomxH0Hasher {
  /**
   * Real H0: RandomX ("rx4096": 512 MiB cache, 4 GiB dataset) over the mining preimage
   * (ar_block.erl compute_h0). Light mode computes dataset items from the cache on demand,
   * giving the node's results without the 4 GiB dataset.
   */
  isStub = false;

  constructor(host) {
    this.host = host;
  }

  async hash(preimage) {
    return this.host.h0(preimage);
  }
}

export class RandomxSquaredEntropySource {
  /**
   * Real replica 2.9 entropy: 8 MiB per entropy key (ar_mine_randomx.erl
   * randomx_generate_replica_2_9_entropy). Holds the most recent entropies so chunks that
   * share one (the same position in different sectors) reuse it.
   */
  isStub = false;

  constructor(host, { keepEntropies = 2 } = {}) {
    this.host = host;
    this.keepEntropies = keepEntropies;
    this.recent = new Map(); // key hex -> Promise<entropy>, in least-recently-used order
  }

  async entropy(entropyKey) {
    const keyHex = Array.from(entropyKey, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!this.recent.has(keyHex)) {
      this.recent.set(keyHex, this.host.entropy(entropyKey));
      while (this.recent.size > this.keepEntropies) this.recent.delete(this.recent.keys().next().value);
    }
    const entropy = this.recent.get(keyHex);
    this.recent.delete(keyHex);
    this.recent.set(keyHex, entropy);
    return entropy;
  }
}
