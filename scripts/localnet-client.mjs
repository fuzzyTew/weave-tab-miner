// scripts/localnet-client.mjs — HTTP to a running Arweave localnet node, for the localnet
// workflow's scripts (localnet-capture.mjs, localnet-post.mjs).
import { NodeClient } from '../src/network/node-client.js';

export class LocalnetClient extends NodeClient {
  /**
   * A NodeClient whose every request carries X-Network: arweave.localnet, or the node
   * treats it as a mainnet request and refuses it.
   */
  static NETWORK_NAME = 'arweave.localnet';

  constructor(baseUrl = 'http://127.0.0.1:1984') {
    super(baseUrl, { headers: { 'x-network': LocalnetClient.NETWORK_NAME }, timeoutMs: 120000 });
  }
}
