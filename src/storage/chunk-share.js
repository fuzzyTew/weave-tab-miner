// src/storage/chunk-share.js — moves packed chunks between two copies of the page that browsers
// keep apart (each site, and files on disk, get their own storage). The copy that wants the
// chunks opens the other in a new window; that window, after the person agrees, sends its
// saved chunks back through postMessage, a batch at a time, waiting for each to be saved.

export class ChunkShareBridge {
  /**
   * Message shapes, all tagged { type: MESSAGE_TYPE }:
   *   sender → receiver: { kind: 'offer', addresses: [{ address, chunkCount }] }
   *                      { kind: 'batch', address, entries: [[offset string, ArrayBuffer]] }
   *                      { kind: 'done' }
   *   receiver → sender: { kind: 'ack' } after each batch is saved
   * The receiver accepts messages only from the window it opened, at the source origin.
   * Packed chunks are public data (anyone can fetch and pack them), so the sender posts to
   * any opener; asking the person first keeps it from happening unnoticed.
   */
  static MESSAGE_TYPE = 'weave-tab-miner/chunk-share';
  static SHARE_HASH = '#share-chunks';
  static DEFAULT_SOURCE_URL = 'https://fuzzytew.github.io/weave-tab-miner/';
  static CHUNKS_PER_BATCH = 32; // 8 MiB a message

  /** Whether this window was opened by another copy asking for chunks. */
  static isShareRequest(windowObject = globalThis) {
    return windowObject.location?.hash === ChunkShareBridge.SHARE_HASH && Boolean(windowObject.opener);
  }

  /**
   * Receiving side. Opens `sourceUrl` (it must be called from a click, or the browser blocks
   * the window) and saves what arrives through `saveBatch(address, entries)`, entries as
   * [[BigInt offset, Uint8Array]]. Resolves with { address: count } when the sender is done.
   */
  static receive({ sourceUrl = ChunkShareBridge.DEFAULT_SOURCE_URL, saveBatch, onOffer = () => {}, onProgress = () => {}, timeoutMs = 600000 }) {
    const sourceOrigin = new URL(sourceUrl).origin;
    const popup = globalThis.open(`${sourceUrl.split('#')[0]}${ChunkShareBridge.SHARE_HASH}`, '_blank');
    if (!popup) return Promise.reject(new Error('the browser blocked the window; allow pop-ups for this page and try again'));
    const received = {};
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`nothing finished within ${timeoutMs / 60000} minutes`)), timeoutMs);
      const finish = (error) => {
        clearTimeout(timer);
        globalThis.removeEventListener('message', onMessage);
        if (error) reject(error); else resolve(received);
      };
      const onMessage = async (event) => {
        if (event.source !== popup || event.origin !== sourceOrigin || event.data?.type !== ChunkShareBridge.MESSAGE_TYPE) return;
        const message = event.data;
        try {
          if (message.kind === 'offer') onOffer(message.addresses);
          if (message.kind === 'batch') {
            const entries = message.entries.map(([offset, buffer]) => [BigInt(offset), new Uint8Array(buffer)]);
            await saveBatch(message.address, entries);
            received[message.address] = (received[message.address] ?? 0) + entries.length;
            onProgress(received);
            popup.postMessage({ type: ChunkShareBridge.MESSAGE_TYPE, kind: 'ack' }, sourceOrigin);
          }
          if (message.kind === 'done') finish(null);
        } catch (error) {
          finish(error);
        }
      };
      globalThis.addEventListener('message', onMessage);
    });
  }

  /**
   * Sending side, in the window opened with SHARE_HASH. `store` is a PackedChunkStore.
   * Sends every saved address's chunks to the opener, waiting for each batch's ack.
   */
  static async send({ store, target = globalThis.opener, onProgress = () => {} }) {
    const addresses = await store.addresses();
    const post = (message, transfer = []) => target.postMessage({ type: ChunkShareBridge.MESSAGE_TYPE, ...message }, '*', transfer);
    const nextAck = () => new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.source !== target || event.data?.type !== ChunkShareBridge.MESSAGE_TYPE || event.data.kind !== 'ack') return;
        globalThis.removeEventListener('message', onMessage);
        resolve();
      };
      globalThis.addEventListener('message', onMessage);
    });
    post({ kind: 'offer', addresses });
    let sent = 0;
    for (const { address } of addresses) {
      // A batch at a time from storage, so a large store never sits in memory whole.
      const offsets = await store.offsets(address);
      for (let start = 0; start < offsets.length; start += ChunkShareBridge.CHUNKS_PER_BATCH) {
        const batch = (await store.loadSome(address, offsets.slice(start, start + ChunkShareBridge.CHUNKS_PER_BATCH)))
          .map(([offset, chunk]) => [offset.toString(), chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)]);
        const acknowledged = nextAck();
        post({ kind: 'batch', address, entries: batch }, batch.map(([, buffer]) => buffer));
        await acknowledged;
        sent += batch.length;
        onProgress(sent);
      }
    }
    post({ kind: 'done' });
    return sent;
  }
}
