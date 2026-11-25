// src/network/network-target.js — which Arweave network the page talks to: the mainnet
// through public gateways and nodes, or a localnet (Arweave's private test chain) through
// one node, as the localnet workflow runs it to check that a browser tab's blocks are taken.
import { NetworkRules } from '../blocks/network-rules.js';

export class NetworkTarget {
  /**
   * `rules`: the NetworkRules blocks are built and mined by. `nodeUrls`: when set, the
   * only place blocks, chunks, accounts and transactions come from and blocks go to, so no
   * gateway or peer is looked for. `stepsComputedHere`: whether VDF steps computed in the
   * tab can keep up with the chain (a localnet's only miner is this tab, so they can).
   * `seededDataBytes`: when set, the weave holds data only in its first this many bytes
   * (a localnet's seeded data), so chunks are fetched there, in order. `heldChunkLimit`:
   * when set, the most chunks worth holding (a localnet takes a block on any one, and its
   * chunks share no entropies, so each costs 32 to pack and keeps RandomX from mining).
   */
  constructor({ name, rules, nodeUrls = null, stepsComputedHere = false, seededDataBytes = null, heldChunkLimit = null }) {
    Object.assign(this, { name, rules, nodeUrls, stepsComputedHere, seededDataBytes, heldChunkLimit });
  }

  static MAINNET = new NetworkTarget({ name: 'mainnet', rules: NetworkRules.MAINNET });

  /** The query parameter naming a localnet node, e.g. ?localnet=http://127.0.0.1:1985 */
  static LOCALNET_PARAMETER = 'localnet';
  // The localnet's snapshot seeds about 21 MiB at the start of the weave.
  static LOCALNET_SEEDED_BYTES = 21 * 1024 * 1024;
  static LOCALNET_HELD_CHUNKS = 1;

  /**
   * A localnet reached at `nodeUrl`. Its node wants an X-Network: arweave.localnet header
   * on every request, which a page cannot send without a CORS preflight the node refuses,
   * so `nodeUrl` is a proxy adding it (scripts/localnet-proxy.mjs).
   */
  static localnet(nodeUrl) {
    return new NetworkTarget({
      name: 'localnet', rules: NetworkRules.LOCALNET, nodeUrls: [nodeUrl.replace(/\/+$/, '')],
      stepsComputedHere: true, seededDataBytes: NetworkTarget.LOCALNET_SEEDED_BYTES, heldChunkLimit: NetworkTarget.LOCALNET_HELD_CHUNKS,
    });
  }

  /** The network a page address asks for: a localnet with ?localnet=<node URL>, else the mainnet. */
  static fromPageAddress(address) {
    const nodeUrl = new URL(address).searchParams.get(NetworkTarget.LOCALNET_PARAMETER);
    return nodeUrl ? NetworkTarget.localnet(nodeUrl) : NetworkTarget.MAINNET;
  }

  get isMainnet() {
    return this.name === 'mainnet';
  }

  /**
   * Weave bytes to fetch chunks at in the partition starting at `partitionStart`: the
   * seeded bytes in order where they are known, else `mainnetPositions` (an iterator of
   * positions sharing entropies, as Replica29Layout.entropySharingPositions gives).
   */
  *chunkPositions(partitionStart, mainnetPositions, chunkSize) {
    if (this.seededDataBytes === null) {
      yield* mainnetPositions;
      return;
    }
    for (let byte = partitionStart; byte < partitionStart + BigInt(this.seededDataBytes); byte += BigInt(chunkSize)) yield byte;
  }
}
