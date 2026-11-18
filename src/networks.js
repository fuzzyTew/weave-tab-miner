// src/networks.js — places a record can be stored permanently, behind one interface, so
// prices can be compared and one record mirrored to several. Each network says which
// transport it needs: a page has HTTP; raw TCP (through Tor) or libp2p (WebRTC,
// WebTransport) would open networks that do not speak HTTP to browsers.
import { DataTransaction } from './transaction.js';
import { DataItem, TurboUploader } from './bundle.js';

export class Transports {
  /**
   * What this environment can reach. Only HTTP exists today; the others are named so a
   * network can say what it is waiting for (see docs/TODO.md, "Reaching the network").
   */
  static AVAILABLE = new Set(['http']);
  static DESCRIPTIONS = {
    http: 'HTTP, which every page has',
    tcp: 'raw TCP, which a page could get through Tor (not built in yet)',
    libp2p: 'libp2p over WebRTC or WebTransport (not built in yet)',
  };

  static isAvailable(name) {
    return Transports.AVAILABLE.has(name);
  }
}

export class StorageNetwork {
  /**
   * One place to store a record. Subclasses set `name`, `howItKeepsData` (one line on what
   * pays for keeping the data) and `transport`, and implement quote and store.
   *
   *   quote(byteCount) → { available, free, cost: string|null, note }
   *   store({ data, tags, wallet }) → { id, link, note }
   * `tags` is [[name, value]] text pairs; `wallet` an ArweaveWallet (src/wallet.js).
   */
  name = 'unnamed';
  howItKeepsData = '';
  transport = 'http';

  get reachable() {
    return Transports.isAvailable(this.transport);
  }

  unreachableNote() {
    return `needs ${Transports.DESCRIPTIONS[this.transport] ?? this.transport}`;
  }

  async quote() {
    throw new Error(`${this.name}: quote is not implemented`);
  }

  async store() {
    throw new Error(`${this.name}: store is not implemented`);
  }
}

export class ArweaveTransactionNetwork extends StorageNetwork {
  /** A plain Arweave transaction sent to a gateway, paid in AR from the signing key. */
  name = 'Arweave, direct';
  howItKeepsData = 'paid once in AR; miners are paid to keep replicas';

  constructor({ gateway }) {
    super();
    this.gateway = gateway;
  }

  async quote(byteCount) {
    if (byteCount > DataTransaction.MAX_INLINE_DATA_SIZE) return { available: false, free: false, cost: null, note: `over ${DataTransaction.MAX_INLINE_DATA_SIZE / 1024} KiB needs chunked upload, not built yet` };
    const winston = await this.gateway.priceWinston(byteCount);
    return { available: true, free: false, cost: `${(Number(winston) / 1e12).toPrecision(3)} AR`, note: 'from the signing key\'s balance' };
  }

  async store({ data, tags, wallet }) {
    const rewardWinston = await this.gateway.priceWinston(data.length);
    const anchor = await this.gateway.transactionAnchor();
    const transaction = await new DataTransaction({ data, anchor, rewardWinston, tags }).sign(wallet);
    const reply = await this.gateway.postTransaction(transaction.toJson());
    return { id: transaction.id, link: `https://arweave.net/${transaction.id}`, note: `sent to ${this.gateway.lastAnsweredBy}: "${String(reply).slice(0, 60)}"` };
  }
}

export class TurboNetwork extends StorageNetwork {
  /** An ANS-104 item signed by the key and handed to ArDrive's Turbo bundler. */
  name = 'Arweave through Turbo';
  howItKeepsData = 'Turbo pays Arweave; free up to 100 KiB';

  constructor({ uploader = new TurboUploader() } = {}) {
    super();
    this.uploader = uploader;
  }

  // Signature, owner and tags add about 1 KiB to the data.
  static ITEM_OVERHEAD_BYTES = 2048;

  async quote(byteCount) {
    const free = byteCount + TurboNetwork.ITEM_OVERHEAD_BYTES <= TurboUploader.FREE_BYTES;
    return free
      ? { available: true, free: true, cost: 'free', note: 'a key with no AR works' }
      : { available: false, free: false, cost: null, note: 'over the free 100 KiB; Turbo credits are not handled here' };
  }

  async store({ data, tags, wallet }) {
    const item = await new DataItem({ data, tags }).sign(wallet);
    const receipt = await this.uploader.upload(item);
    if (receipt.id !== item.id) throw new Error(`Turbo answered for a different id, ${receipt.id}`);
    return { id: item.id, link: `https://arweave.net/${item.id}`, note: receipt.winc === '0' ? 'accepted for free' : `charged ${receipt.winc} winc` };
  }
}

export class AutonomiNetwork extends StorageNetwork {
  /**
   * STUB — Autonomi (formerly MaidSafe): pay once at upload; nodes keep copies as they
   * join and leave. Its nodes speak libp2p, which a page cannot reach yet, so quote and
   * store only say what is missing. A real client would go here once a libp2p transport
   * exists (docs/TODO.md).
   */
  name = 'Autonomi';
  howItKeepsData = 'paid once at upload; nodes replicate as they come and go';
  transport = 'libp2p';

  async quote() {
    return { available: false, free: false, cost: null, note: this.unreachableNote() };
  }

  async store() {
    throw new Error(`Autonomi ${this.unreachableNote()}`);
  }
}

export class RecordMirror {
  /**
   * Compares and stores one record across several networks. Each network's result stands
   * alone: one failing does not stop the others.
   */
  constructor(networks) {
    this.networks = networks;
  }

  async compare(byteCount) {
    return Promise.all(this.networks.map(async (network) => {
      if (!network.reachable) return { network, available: false, free: false, cost: null, note: network.unreachableNote() };
      try {
        return { network, ...(await network.quote(byteCount)) };
      } catch (error) {
        return { network, available: false, free: false, cost: null, note: `no quote: ${error.message.split('\n')[0]}` };
      }
    }));
  }

  async storeEverywhere(record, onResult = () => {}) {
    const results = [];
    for (const network of this.networks) {
      let result;
      try {
        if (!network.reachable) throw new Error(network.unreachableNote());
        result = { network, ok: true, ...(await network.store(record)) };
      } catch (error) {
        result = { network, ok: false, note: error.message.split('\n')[0] };
      }
      results.push(result);
      onResult(result);
    }
    return results;
  }
}
