// src/network/vdf-client.js — reading VDF steps from a public VDF server, so a miner can keep
// pace with the network (about one step a second) instead of computing steps itself.
//
// A node answers GET /vdf only if its operator made it a public VDF server, or to clients
// it was configured to serve (handle_get_vdf in ar_http_iface_middleware.erl); everyone
// else gets 400 not_our_vdf_client. Whether any gateway or peer serves it is found by asking.
import { Bytes } from '../core/bytes.js';

export class VdfUpdate {
  /**
   * Parses the binary body of GET /vdf (format 2: ar_serialize.erl
   * nonce_limiter_update_to_binary and encode_vdf_session). Integers marked encode_int are
   * a one-byte length followed by that many big-endian bytes.
   */
  static parse(body) {
    const reader = new ByteReader(body);
    const update = {
      nextSeed: reader.bytes(48),
      nextVdfDifficulty: reader.encodedInt(),
      interval: reader.uint(8),
      isPartial: reader.uint(1) === 1n,
    };
    const checkpointCount = Number(reader.uint(2));
    update.checkpoints = Array.from({ length: checkpointCount }, () => reader.bytes(32));
    update.stepNumber = Number(reader.uint(8));
    update.seed = reader.bytes(48);
    update.upperBound = reader.encodedInt();
    update.nextUpperBound = reader.encodedInt();
    const stepCount = Number(reader.uint(2));
    // Assumption: like a block's checkpoints, the session's steps run newest first.
    update.stepsNewestFirst = Array.from({ length: stepCount }, () => reader.bytes(32));
    return update;
  }

  /**
   * The update's newest step's 25 checkpoints, oldest first (the step's output last), or
   * null if they do not end on that step's output. Servers send them newest first, as
   * blocks list last_step_checkpoints; both orders are accepted.
   */
  static lastStepCheckpoints(update) {
    const output = update.stepsNewestFirst[0];
    if (!output || update.checkpoints.length !== 25) return null;
    const same = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]);
    if (same(update.checkpoints[0], output)) return update.checkpoints.slice().reverse();
    if (same(update.checkpoints.at(-1), output)) return update.checkpoints.slice();
    return null;
  }

  /** [stepNumber, output] pairs, oldest first, after `afterStepNumber`. */
  static steps(update, afterStepNumber) {
    return update.stepsNewestFirst
      .map((output, index) => [update.stepNumber - index, output])
      .filter(([stepNumber]) => stepNumber > afterStepNumber)
      .reverse();
  }
}

export class VdfStepRecord {
  /**
   * Every step output seen from VDF server updates (or computed here), by step number, and
   * the checkpoints of steps that came as an update's newest (or were computed here): what a block's nonce_limiter_info lists for the
   * steps since its parent. Keeps the newest `keepSteps` (a block may list 10,800).
   */
  constructor({ keepSteps = 12_000, keepCheckpointSteps = 64 } = {}) {
    Object.assign(this, { keepSteps, keepCheckpointSteps });
    this.outputsByStep = new Map();
    this.checkpointsByStep = new Map();
  }

  add(update) {
    for (const [stepNumber, output] of VdfUpdate.steps(update, -1)) this.outputsByStep.set(stepNumber, output);
    const checkpoints = VdfUpdate.lastStepCheckpoints(update);
    if (checkpoints) this.checkpointsByStep.set(update.stepNumber, checkpoints);
    VdfStepRecord.trimOldest(this.outputsByStep, this.keepSteps);
    VdfStepRecord.trimOldest(this.checkpointsByStep, this.keepCheckpointSteps);
  }

  /** A step computed here: its 25 checkpoints, oldest first, the last being its output. */
  addComputedStep(stepNumber, checkpoints) {
    this.outputsByStep.set(stepNumber, checkpoints.at(-1));
    this.checkpointsByStep.set(stepNumber, checkpoints);
    VdfStepRecord.trimOldest(this.outputsByStep, this.keepSteps);
    VdfStepRecord.trimOldest(this.checkpointsByStep, this.keepCheckpointSteps);
  }

  static trimOldest(map, keep) {
    if (map.size <= keep) return;
    const steps = [...map.keys()].sort((left, right) => left - right);
    for (const step of steps.slice(0, map.size - keep)) map.delete(step);
  }

  /** The steps after `afterStep` up to `throughStep` that are not held. */
  /** The newest step held, or -1. */
  get newestStep() {
    let newest = -1;
    for (const step of this.outputsByStep.keys()) if (step > newest) newest = step;
    return newest;
  }

  /** [stepNumber, output] pairs held after `afterStep`, oldest first. */
  stepsAfter(afterStep) {
    return [...this.outputsByStep.entries()].filter(([step]) => step > afterStep).sort(([left], [right]) => left - right);
  }

  missingSteps(afterStep, throughStep) {
    const missing = [];
    for (let step = afterStep + 1; step <= throughStep; step++) if (!this.outputsByStep.has(step)) missing.push(step);
    return missing;
  }
}

export class ByteReader {
  /**
   * Sequential big-endian reads over a byte array, failing loudly past the end.
   */
  constructor(bytes) {
    this.bytesView = bytes;
    this.position = 0;
  }

  bytes(count) {
    if (this.position + count > this.bytesView.length) throw new Error(`VDF update ended early at byte ${this.position} (wanted ${count} more)`);
    const slice = this.bytesView.slice(this.position, this.position + count);
    this.position += count;
    return slice;
  }

  uint(byteCount) {
    return Bytes.toBigInt(this.bytes(byteCount));
  }

  encodedInt() {
    const length = Number(this.uint(1));
    return length === 0 ? 0n : this.uint(length);
  }
}

export class VdfServerClient {
  /**
   * Polls GET /vdf on each candidate base URL until one answers, then keeps polling that one.
   */
  static POLL_INTERVAL_MS = 500;

  /**
   * The Arweave team's public VDF servers named in the mining docs (vdf-server-5 was retired
   * in release N.2.9.7). Nodes answer plain http on port 1984; https is tried first in case
   * one is served there, since only https works from an https page.
   */
  static PUBLIC_SERVER_URLS = [
    'https://vdf-server-3.arweave.xyz', 'https://vdf-server-4.arweave.xyz',
    'http://vdf-server-3.arweave.xyz:1984', 'http://vdf-server-4.arweave.xyz:1984',
  ];

  constructor({ baseUrls, timeoutMs = 5000, log = () => {} }) {
    Object.assign(this, { baseUrls, timeoutMs, log });
    this.serverUrl = null;
  }

  /**
   * GET /vdf: the server's latest update, which holds only its newest 2 steps
   * (ar_nonce_limiter_server REGULAR_UPDATE_INCLUDE_STEPS_COUNT); `path` "/vdf/session"
   * gets the whole current session instead, to fill a gap between polls, and
   * "/vdf/previous_session" the one before.
   */
  async fetchUpdate(baseUrl, path = '/vdf') {
    const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`);
    // Some gateways answer unknown paths with their web app's HTML page and status 200
    // (turbo-gateway.com did in the live check), which is not a VDF update.
    const contentType = response.headers.get('content-type') ?? '';
    if (/text\/html|application\/json/i.test(contentType)) throw new Error(`answered with ${contentType}, not a VDF update`);
    return VdfUpdate.parse(new Uint8Array(await response.arrayBuffer()));
  }

  /**
   * Clients for every one of `baseUrls` that answers, tried together. Public servers run
   * at different paces (measured: ~0.6 steps a second each, some in bursts, against the
   * network's ~1), so polling all of them and taking the newest steps keeps up best.
   */
  static async allAnswering(baseUrls, { timeoutMs = 5000, log = () => {} } = {}) {
    const tried = await Promise.all(baseUrls.map(async (baseUrl) => {
      const client = new VdfServerClient({ baseUrls: [baseUrl], timeoutMs, log });
      await client.findServer();
      return client;
    }));
    return { clients: tried.filter((client) => client.serverUrl), failures: tried.flatMap((client) => client.failures) };
  }

  /** Finds a server that answers. Returns its URL, or null with each refusal logged. */
  async findServer() {
    this.failures = [];
    for (const baseUrl of this.baseUrls) {
      try {
        await this.fetchUpdate(baseUrl);
        this.serverUrl = baseUrl;
        return baseUrl;
      } catch (error) {
        const reason = VdfServerClient.describeFailure(error, baseUrl, this.timeoutMs);
        this.failures.push({ url: baseUrl, reason });
        this.log(`no VDF from ${baseUrl}: ${reason}`);
      }
    }
    return null;
  }

  /**
   * Why a request failed, in plain words: no answer in time, refused by the browser (an
   * https page asking plain http, or the server not allowing pages), or what the server said.
   */
  static describeFailure(error, baseUrl, timeoutMs) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return `no answer within ${Math.round(timeoutMs / 1000)} s`;
    const httpsPage = globalThis.location?.protocol === 'https:';
    if (error.name === 'TypeError') {
      return httpsPage && baseUrl.startsWith('http:') ? 'blocked: an https page may not ask plain http unless insecure content is allowed' : `could not connect (${error.message}); the network may block it`;
    }
    return error.message;
  }

  async latest() {
    if (!this.serverUrl) throw new Error('no VDF server found yet');
    return this.fetchUpdate(this.serverUrl);
  }

  /** The session before the current one, for steps from before the last reset line. */
  async previousSession() {
    if (!this.serverUrl) throw new Error('no VDF server found yet');
    return this.fetchUpdate(this.serverUrl, '/vdf/previous_session');
  }

  /** The whole current session (every step since the last reset line). */
  async session() {
    if (!this.serverUrl) throw new Error('no VDF server found yet');
    return this.fetchUpdate(this.serverUrl, '/vdf/session');
  }
}

export class VdfServerPool {
  /**
   * Several VDF servers polled together, their steps merged in one VdfStepRecord. Public
   * servers each run at their own pace (measured: about 0.6 steps a second each, some in
   * bursts, against the network's ~1), so the newest of them is followed. An update holds
   * only a server's newest 2 steps; when steps are missing since the last one mined, the
   * newest server's whole session fills them (seconds old, still worth mining).
   */
  constructor({ clients, record = new VdfStepRecord() }) {
    Object.assign(this, { clients, record });
  }

  /**
   * { pool, failures }: a pool of every one of `baseUrls` that answers (null if none does),
   * and why each other one did not ([{ url, reason }]).
   */
  static async connect(baseUrls, options = {}) {
    const { clients, failures } = await VdfServerClient.allAnswering(baseUrls, options);
    return { pool: clients.length ? new VdfServerPool({ clients, record: options.record }) : null, failures };
  }

  get serverUrls() {
    return this.clients.map((client) => client.serverUrl);
  }

  /**
   * One round: every server asked at once. Resolves { newest, fresh, gapFilled, missing }:
   * the newest update (its seeds are the current ones), the held steps after `afterStep` up
   * to it as [stepNumber, output] oldest first, whether a session filled a gap, and how
   * many steps stayed missing. Throws only if no server answered, with each one's reason.
   */
  async poll(afterStep) {
    const answers = await Promise.allSettled(this.clients.map((client) => client.latest()));
    const updates = answers.filter((answer) => answer.status === 'fulfilled').map((answer) => answer.value);
    if (!updates.length) throw new Error(answers.map((answer, index) => `${this.clients[index].serverUrl}: ${answer.reason?.message}`).join('; '));
    const newest = updates.reduce((best, update) => (update.stepNumber > best.stepNumber ? update : best));
    for (const update of updates) this.record.add(update);

    let gapFilled = false;
    if (afterStep >= 0 && this.record.missingSteps(afterStep, newest.stepNumber).length) {
      const best = this.clients[answers.findIndex((answer) => answer.value === newest)];
      this.record.add(await best.session());
      gapFilled = true;
    }
    return {
      newest, gapFilled, newestFrom: this.clients[answers.findIndex((answer) => answer.value === newest)].serverUrl,
      missing: afterStep >= 0 ? this.record.missingSteps(afterStep, newest.stepNumber).length : 0,
      fresh: this.record.stepsAfter(afterStep).filter(([step]) => step <= newest.stepNumber),
    };
  }

  /** Stops polling `serverUrl` (one whose steps failed a check); resolves how many servers remain. */
  drop(serverUrl) {
    this.clients = this.clients.filter((client) => client.serverUrl !== serverUrl);
    return this.clients.length;
  }

  /** Fills `record` with the steps since `afterStep`, from the previous and current sessions. */
  async fillSince(afterStep, throughStep) {
    for (const client of this.clients) {
      if (!this.record.missingSteps(afterStep, throughStep).length) return;
      try {
        this.record.add(await client.previousSession());
        this.record.add(await client.session());
      } catch {
        // The next server may have them.
      }
    }
  }
}

