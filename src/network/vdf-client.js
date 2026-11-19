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

  /** [stepNumber, output] pairs, oldest first, after `afterStepNumber`. */
  static steps(update, afterStepNumber) {
    return update.stepsNewestFirst
      .map((output, index) => [update.stepNumber - index, output])
      .filter(([stepNumber]) => stepNumber > afterStepNumber)
      .reverse();
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

  async fetchUpdate(baseUrl) {
    const response = await fetch(`${baseUrl}/vdf`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`);
    // Some gateways answer unknown paths with their web app's HTML page and status 200
    // (turbo-gateway.com did in the live check), which is not a VDF update.
    const contentType = response.headers.get('content-type') ?? '';
    if (/text\/html|application\/json/i.test(contentType)) throw new Error(`answered with ${contentType}, not a VDF update`);
    return VdfUpdate.parse(new Uint8Array(await response.arrayBuffer()));
  }

  /** Finds a server that answers. Returns its URL, or null with each refusal logged. */
  async findServer() {
    for (const baseUrl of this.baseUrls) {
      try {
        await this.fetchUpdate(baseUrl);
        this.serverUrl = baseUrl;
        return baseUrl;
      } catch (error) {
        this.log(`no VDF from ${baseUrl}: ${error.message}`);
      }
    }
    return null;
  }

  async latest() {
    if (!this.serverUrl) throw new Error('no VDF server found yet');
    return this.fetchUpdate(this.serverUrl);
  }
}
