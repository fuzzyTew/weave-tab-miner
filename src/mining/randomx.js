// src/mining/randomx.js — Arweave's two RandomX uses, run through randomx.js built for Arweave
// (vendor/randomx-arweave): H0, and the replica 2.9 packing entropy ("RandomX squared").
// Both share one 512 MiB RandomX cache keyed by RANDOMX_PACKING_KEY.
import { Sha256 } from '../core/sha256.js';

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
   * src/mining/workers/randomx-worker.js (or its inlined copy in the single-file build).
   */
  constructor(createWorker) {
    this.worker = createWorker();
    this.pending = new Map();
    this.nextId = 1;
    // One request runs in the worker at a time; waiting ones queue here, H0 before
    // entropy, so a step's H0 waits for at most one entropy (about a second) rather than
    // behind a whole packing batch. The worker itself answers in the order it is sent.
    this.waiting = { urgent: [], background: [] };
    this.running = null;
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      this.running = null;
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
      this.sendNext();
    };
    this.worker.onerror = (event) => {
      const error = new Error(`RandomX worker failed: ${event.message || 'no reason given'}`);
      for (const request of this.pending.values()) request.reject(error);
      for (const queued of [...this.waiting.urgent, ...this.waiting.background]) queued.reject(error);
      this.pending.clear();
      this.waiting = { urgent: [], background: [] };
      this.running = null;
    };
    this.readyPromise = this.call('init', undefined, { urgent: true });
  }

  /** Queues one request; `urgent` ones (H0, and starting up) go before the rest. */
  call(kind, payload, { urgent = false } = {}) {
    return new Promise((resolve, reject) => {
      this.waiting[urgent ? 'urgent' : 'background'].push({ kind, payload, resolve, reject });
      this.sendNext();
    });
  }

  sendNext() {
    if (this.running) return;
    const next = this.waiting.urgent.shift() ?? this.waiting.background.shift();
    if (!next) return;
    const id = this.nextId++;
    this.running = id;
    this.pending.set(id, next);
    this.worker.postMessage({ id, kind: next.kind, payload: next.payload });
  }

  /** Requests waiting or running: for a page that wants to say packing is slowing mining. */
  get queuedCount() {
    return this.waiting.urgent.length + this.waiting.background.length + (this.running ? 1 : 0);
  }

  ready() {
    return this.readyPromise;
  }

  async h0(preimage) {
    await this.readyPromise;
    return this.call('h0', preimage, { urgent: true });
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
    this.RandomxArweave = RandomxArweave;
    this.engineState = null;
  }

  /** Made on first use: its 512 MiB cache takes seconds, wasted when stored results answer everything. */
  get engine() {
    this.engineState ??= RandomxRequests.createEngine(this.RandomxArweave);
    return this.engineState;
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

  /** `store` (optional): get(keyHex)/set(keyHex, hash) keeping hashes by their preimage's SHA-256, across runs. */
  constructor(host, { store = null } = {}) {
    this.host = host;
    this.store = store;
  }

  async hash(preimage) {
    if (!this.store) return this.host.h0(preimage);
    const keyHex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', preimage)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const stored = await this.store.get(keyHex);
    if (stored) return stored;
    const hash = await this.host.h0(preimage);
    await this.store.set(keyHex, hash);
    return hash;
  }
}

export class RandomxSquaredEntropySource {
  /**
   * Real replica 2.9 entropy: 8 MiB per entropy key (ar_mine_randomx.erl
   * randomx_generate_replica_2_9_entropy). Holds the most recent entropies so chunks that
   * share one (the same position in different sectors) reuse it.
   *
   * `store` (optional) keeps entropies beyond that, across runs: `get(keyHex)` resolves
   * the entropy or null, `set(keyHex, entropy)` keeps one. Each costs seconds of RandomX,
   * so a store pays when the same ones come back (tests replaying blocks, repacking).
   */
  isStub = false;

  constructor(host, { keepEntropies = 2, store = null } = {}) {
    this.host = host;
    this.keepEntropies = keepEntropies;
    this.store = store;
    this.recent = new Map(); // key hex -> Promise<entropy>, in least-recently-used order
  }

  /** The entropy from the store if it has it, else computed (and given to the store). */
  async storedOrComputed(entropyKey, keyHex) {
    const stored = await this.store?.get(keyHex);
    if (stored) return stored;
    const entropy = await this.host.entropy(entropyKey);
    await this.store?.set(keyHex, entropy);
    return entropy;
  }

  async entropy(entropyKey) {
    const keyHex = Array.from(entropyKey, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!this.recent.has(keyHex)) {
      this.recent.set(keyHex, this.storedOrComputed(entropyKey, keyHex));
      while (this.recent.size > this.keepEntropies) this.recent.delete(this.recent.keys().next().value);
    }
    const entropy = this.recent.get(keyHex);
    this.recent.delete(keyHex);
    this.recent.set(keyHex, entropy);
    return entropy;
  }
}
