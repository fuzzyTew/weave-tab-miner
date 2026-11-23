// apps/browser/holding-panel.js — Holding packed data: fetching, packing, saving, restoring, exporting, repacking and sharing chunks.
// Its methods are mixed into BrowserNodeApp (see app.js), so `this` is the app.
import { Bytes } from '../../src/core/bytes.js';
import { ConsensusConstants } from '../../src/core/constants.js';
import { Replica29Layout, ChunkPacker } from '../../src/mining/packing.js';
import { MiningIdentity } from '../../src/mining/identity.js';
import { HeldStorage } from '../../src/mining/held-storage.js';
import { ChunkFetcher } from '../../src/network/chunk-fetcher.js';
import { ChunkShareBridge } from '../../src/storage/chunk-share.js';
import { PackedChunkStore, PackedChunkArchive } from '../../src/storage/chunk-store.js';
import { PageView } from './page-view.js';

export class HoldingPanel {
  // ---- browser storage ----

  // Chunks kept in memory at once (64 × 256 KiB = 16 MiB); the rest are read from storage.
  static RESIDENT_CHUNKS = 64;

  heldStorageFor(identity) {
    return new HeldStorage({ loadChunk: (offset) => this.store.loadOne(identity.address, offset), residentLimit: HoldingPanel.RESIDENT_CHUNKS });
  }

  async restoreStoredChunks() {
    // Stand-in packing is never saved, so anything stored is real packing.
    // Only the offsets: the chunks themselves are read from storage when a step needs them.
    const entries = await this.store.offsets(this.identity.address);
    for (const bucketEndOffset of entries) this.storage.addOnDisk(bucketEndOffset);
    if (entries.length) {
      this.view.log(`restored ${entries.length} packed chunk${entries.length === 1 ? '' : 's'} from browser storage`, 'good');
      this.view.setText('holdStatus', `Holding ${entries.length} packed chunk${entries.length === 1 ? '' : 's'} saved in this browser earlier.`);
      this.choosePartitionWithMostHeld();
    }
    await this.refreshStorageNote();
  }

  /** Mining tries one partition; pick the one holding the most chunks, if the current holds none. */
  choosePartitionWithMostHeld() {
    if (this.storage.bytesInPartition(this.partitionNumber) > 0) return;
    const counts = new Map();
    for (const key of this.storage.packedChunks.keys()) {
      const partition = Number((BigInt(key) - 1n) / ConsensusConstants.PARTITION_SIZE);
      counts.set(partition, (counts.get(partition) ?? 0) + 1);
    }
    const [best] = [...counts].sort((left, right) => right[1] - left[1]);
    if (!best) return;
    this.view.elements.partitionInput.value = best[0];
    this.view.log(`partition set to ${best[0]}, where ${best[1]} held chunk${best[1] === 1 ? ' is' : 's are'}`);
  }

  /** Lists every address with chunks saved here, each with a button to mine for it. */
  async refreshSavedAddresses() {
    const list = this.view.elements.savedAddresses;
    const saved = await this.store.addresses();
    list.replaceChildren(...saved.map(({ address, chunkCount }) => {
      const item = document.createElement('li');
      const current = address === this.identity?.address;
      item.append(`${current ? 'This address' : 'Saved here'}: ${address}, ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}`);
      const addButton = (label, action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', action);
        item.append(button);
      };
      if (!current) {
        addButton('Mine for it', () => {
          this.view.elements.addressInput.value = address;
          this.useAddress();
        });
        if (this.identity && !this.identity.verificationOnly) addButton('Repack for this address', () => this.repackFrom(address));
      }
      addButton('Delete', () => this.deleteSaved(address, chunkCount));
      return item;
    }));
  }

  /**
   * Turns chunks saved for another address into chunks for this one, with no download:
   * unpacking and packing are both XORs with entropy (ChunkPacker.repackChunks).
   */
  async repackFrom(address, { deleteOriginals = false } = {}) {
    this.view.setText('holdStatus', 'Waiting for RandomX to be ready…');
    await this.randomxReady;
    if (!this.usingRealRandomx) {
      this.view.setText('holdStatus', 'Repacking needs real RandomX, which this browser could not start.');
      return;
    }
    const offsets = await this.store.offsets(address);
    const started = performance.now();
    const target = this.identity;
    let repackedCount = 0;
    // A batch at a time from storage, so a large set never sits in memory whole.
    for (let start = 0; start < offsets.length; start += HoldingPanel.CHUNK_BATCH_SIZE) {
      const batch = await this.store.loadSome(address, offsets.slice(start, start + HoldingPanel.CHUNK_BATCH_SIZE));
      const repacked = await ChunkPacker.repackChunks({
        entries: batch, fromIdentity: MiningIdentity.fromAddress(address), toIdentity: target, entropySource: this.entropySource,
        onEntropy: (done, total) => this.view.setText('holdStatus', `Repacking chunks ${start + 1}–${start + batch.length} of ${offsets.length}: entropy ${done} of ${total}…`),
      });
      if (target !== this.identity) return; // the person switched identity meanwhile
      for (const [offset, chunk] of repacked) this.storage.add(offset, chunk);
      await this.saveChunks(repacked);
      repackedCount += repacked.length;
    }
    if (deleteOriginals) await this.store.deleteAddress(address);
    this.choosePartitionWithMostHeld();
    this.view.setText('holdStatus', `Repacked ${repackedCount} chunks from ${address.slice(0, 8)}… for this address in ${((performance.now() - started) / 1000).toFixed(0)} s.${deleteOriginals ? '' : ' The originals are still saved; delete them if you no longer need them.'}`);
    this.view.log(`repacked ${repackedCount} chunks from ${address} for ${this.identity.address}`, 'good');
    await this.refreshStorageNote();
  }

  /**
   * Before mining, moves every chunk saved for other addresses to this one, so all the
   * storage counts: repacked for this address, then the old copies deleted (they can be
   * repacked back the same way). Not for verification-only identities, which never pack.
   */
  async repackEverythingForThisAddress() {
    if (this.identity.verificationOnly || !this.usingRealRandomx) return;
    const others = (await this.store.addresses()).filter(({ address }) => address !== this.identity.address);
    for (const { address, chunkCount } of others) {
      this.view.log(`moving ${chunkCount} chunks packed for ${address.slice(0, 8)}… to this address before mining`);
      await this.repackFrom(address, { deleteOriginals: true });
    }
  }

  async deleteSaved(address, chunkCount) {
    if (!confirm(`Delete ${chunkCount} packed chunks saved for ${address}?`)) return;
    await this.store.deleteAddress(address);
    if (address === this.identity?.address) this.storage = this.heldStorageFor(this.identity);
    this.view.log(`deleted ${chunkCount} saved chunks for ${address}`);
    await this.refreshStorageNote();
  }

  /** From a copy on disk: open the website copy, which sends its saved chunks here. */
  async bringChunksFromWebsite() {
    this.view.setText('holdStatus', 'Opening the website copy; agree there to send its chunks…');
    try {
      const received = await ChunkShareBridge.receive({
        sourceUrl: localStorage.getItem('weave-tab-miner.share-source') ?? ChunkShareBridge.DEFAULT_SOURCE_URL,
        saveBatch: async (address, entries) => {
          if (!(await this.store.save(address, entries))) throw new Error('this browser refused to store them');
          if (address === this.identity?.address) for (const [offset] of entries) this.storage.addOnDisk(offset);
        },
        onOffer: (addresses) => this.view.log(`the website copy offers ${addresses.map(({ address, chunkCount }) => `${chunkCount} for ${address.slice(0, 8)}…`).join(', ') || 'nothing'}`),
        onProgress: (counts) => this.view.setText('holdStatus', `Received ${Object.values(counts).reduce((sum, count) => sum + count, 0)} chunks…`),
      });
      const total = Object.values(received).reduce((sum, count) => sum + count, 0);
      this.view.setText('holdStatus', total ? `Brought over ${total} packed chunks; they are saved here now.` : 'The website copy had no saved chunks.');
      this.view.log(`brought ${total} chunks from the website copy`, 'good');
      this.choosePartitionWithMostHeld();
      await this.refreshStorageNote();
    } catch (error) {
      this.view.setText('holdStatus', `Nothing brought over: ${error.message}`);
      this.view.log(`chunk sharing failed: ${error.message}`, 'error');
    }
  }

  /** In a window opened by another copy asking for chunks: say so and wait for consent. */
  async offerShare() {
    const addresses = await this.store.addresses();
    const total = addresses.reduce((sum, { chunkCount }) => sum + chunkCount, 0);
    this.view.elements.shareRequest.hidden = false;
    this.view.setText('shareRequestNote', `It would receive ${total} packed chunks (${PageView.formatBytes(total * ConsensusConstants.DATA_CHUNK_SIZE)}) for ${addresses.length} address${addresses.length === 1 ? '' : 'es'}. Packed chunks are public data, so nothing secret is shared; no key is ever sent.`);
    this.view.elements.sendChunksButton.addEventListener('click', async () => {
      this.view.elements.sendChunksButton.disabled = true;
      const sent = await ChunkShareBridge.send({ store: this.store, onProgress: (count) => this.view.setText('shareRequestNote', `Sent ${count} of ${total}…`) });
      this.view.setText('shareRequestNote', `Sent ${sent} chunks. You can close this window.`);
    }, { once: true });
  }

  /**
   * Saves this address's packed chunks to a file, a batch at a time (a few GB never sit in
   * memory). Above STREAM_TO_FILE_BYTES, where the browser can write a chosen file directly
   * (the File System Access API), it streams there, asking where to save; otherwise the
   * batches become one download. Progress and any failure show in the Hold data status.
   */
  static STREAM_TO_FILE_BYTES = 256 * 2 ** 20;

  async exportChunks() {
    const offsets = this.identity ? await this.store.offsets(this.identity.address) : [];
    if (!offsets.length) {
      this.view.setText('holdStatus', 'Nothing saved for this address to export. Only real (RandomX) packing is saved.');
      return;
    }
    const address = this.identity.address;
    const fileName = PackedChunkArchive.fileName(address, offsets.length);
    const size = PageView.formatBytes(offsets.length * PackedChunkArchive.CHUNK_SIZE);
    const onProgress = (done, total) => this.view.setText('holdStatus', `Exporting: ${done.toLocaleString()} of ${total.toLocaleString()} chunks (${size} in all)…`);
    const parts = PackedChunkArchive.parts(address, offsets, (wanted) => this.store.loadSome(address, wanted), { onProgress });
    try {
      if (window.showSaveFilePicker && offsets.length * PackedChunkArchive.CHUNK_SIZE > HoldingPanel.STREAM_TO_FILE_BYTES) {
        let handle;
        try {
          handle = await window.showSaveFilePicker({ suggestedName: fileName });
        } catch (error) {
          if (error.name === 'AbortError') {
            this.view.setText('holdStatus', 'Export cancelled.');
            return;
          }
          throw error;
        }
        const writable = await handle.createWritable();
        try {
          for await (const part of parts) await writable.write(part);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
      } else {
        const collected = [];
        for await (const part of parts) collected.push(part);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob(collected, { type: 'application/octet-stream' }));
        link.download = fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 600000);
      }
      this.view.setText('holdStatus', `Exported ${offsets.length.toLocaleString()} packed chunks (${size}) as ${fileName}.`);
      this.view.log(`exported ${offsets.length} packed chunks as ${fileName}`, 'good');
    } catch (error) {
      this.view.setText('holdStatus', `Export stopped: ${error.message}. Nothing was lost; try again, or free disk space if the browser ran out.`);
      this.view.log(`export failed: ${error.message}`, 'error');
    }
  }

  /** Loads an exported file, a batch at a time, into this browser's storage. */
  async importChunks() {
    const [file] = this.view.elements.importChunksInput.files;
    if (!file) return;
    this.view.elements.importChunksInput.value = '';
    let address = null;
    let imported = 0;
    try {
      for await (const batch of PackedChunkArchive.batches(file)) {
        address = batch.address;
        if (!(await this.store.save(address, batch.entries))) throw new Error('this browser refused to store them (storage full, or private browsing)');
        if (address === this.identity?.address) for (const [offset] of batch.entries) this.storage.addOnDisk(offset);
        imported += batch.entries.length;
        this.view.setText('holdStatus', `Importing: ${imported.toLocaleString()} chunks so far…`);
      }
      if (address === this.identity?.address) {
        this.choosePartitionWithMostHeld();
        this.view.setText('holdStatus', `Imported ${imported.toLocaleString()} packed chunks for this address.`);
      } else {
        this.view.setText('holdStatus', `Imported ${imported.toLocaleString()} packed chunks for ${address}. They only work for that address: use "Mine for it" below.`);
      }
      this.view.log(`imported ${imported} packed chunks for ${address} from ${file.name}`, 'good');
    } catch (error) {
      const kept = imported ? ` The ${imported.toLocaleString()} chunks before that were kept.` : '';
      this.view.setText('holdStatus', `Import stopped: ${error.message}.${kept}`);
      this.view.log(`import of ${file.name} failed: ${error.message}`, 'error');
    }
    await this.refreshStorageNote();
    this.refreshSummary();
  }

  async saveChunks(entries) {
    if (!this.usingRealRandomx) return;
    if (await this.store.save(this.identity.address, entries)) {
      this.storage.markReloadable(entries.map(([offset]) => offset));
      const persistent = await PackedChunkStore.requestPersistence();
      this.view.log(`saved ${entries.length} packed chunk${entries.length === 1 ? '' : 's'} to browser storage${persistent ? '' : ' (the browser may clear it if disk runs low)'}`);
    }
    await this.refreshStorageNote();
  }

  // ---- how much storage to use ----

  // A new key: settings saved under the first slider were clamped to its 2 GiB range.
  static STORAGE_TARGET_KEY = 'weave-tab-miner.storage-target';
  static STORAGE_STEP_BYTES = 64 * 2 ** 20;

  /** The slider's setting in bytes: how much this tab aims to hold for its address. */
  get storageTargetBytes() {
    return Number(this.view.elements.storageTargetInput.value);
  }

  /**
   * Restores the slider and follows it. The setting is remembered as a number of bytes, or
   * as "max" (the default): all the browser allows, which grows when the browser allows
   * more. It is applied once the browser's allowance is known, since the slider's range
   * clamps any value set before that.
   */
  setUpStorageSlider() {
    const slider = this.view.elements.storageTargetInput;
    this.storageTargetSetting = 'max';
    try {
      const saved = localStorage.getItem(HoldingPanel.STORAGE_TARGET_KEY);
      if (Number(saved) > 0) this.storageTargetSetting = Number(saved);
    } catch {
      // Storage refused: the default applies each visit.
    }
    slider.addEventListener('input', () => {
      this.storageTargetSetting = slider.value === slider.max ? 'max' : Number(slider.value);
      try {
        localStorage.setItem(HoldingPanel.STORAGE_TARGET_KEY, String(this.storageTargetSetting));
      } catch {
        // Not remembered; applies to this visit.
      }
      this.refreshStorageSlider();
      this.fillStorageInBackground();
    });
    this.refreshStorageSlider();
  }

  /**
   * Holding data is the slow part of mining and worth having before mining starts, so
   * with a live block loaded the tab fetches toward "Storage to use" in the background,
   * mining or not (packing shares the CPU with mining, slowing each step a little;
   * storage is by far the larger factor). Quick start fetches its own first batch.
   */
  async fillStorageInBackground() {
    if (this.holdStopper || this.quickStarting || this.blockOrigin !== 'live' || !this.identity || !this.chunksToReachTarget()) return;
    this.view.log(`filling storage toward ${PageView.formatBytes(this.storageTargetBytes)} in the background`);
    await this.holdChunks();
  }

  /**
   * The slider's range (up to 90% of what the browser allows, in whole steps), its position
   * from the setting, and its text and meter: the amount set, the allowance, how full.
   */
  refreshStorageSlider() {
    const { storageTargetInput: slider, storageFillMeter: meter } = this.view.elements;
    const step = HoldingPanel.STORAGE_STEP_BYTES;
    if (this.storageQuotaBytes) slider.max = String(Math.max(step, Math.floor(this.storageQuotaBytes * 0.9 / step) * step));
    const setting = this.storageTargetSetting ?? 'max';
    slider.value = String(setting === 'max' ? Number(slider.max) : Math.min(setting, Number(slider.max)));
    const target = this.storageTargetBytes;
    const held = this.storage.byteCount;
    meter.value = target ? Math.min(1, held / target) : 0;
    const allowed = this.storageQuotaBytes ? ` of about ${PageView.formatBytes(this.storageQuotaBytes)} this browser allows` : '';
    const over = held > target ? ' — more than set, so nothing more is fetched' : '';
    this.view.setText('storageTargetText', `${PageView.formatBytes(target)}${allowed}; ${PageView.formatBytes(held)} held (${target ? Math.round(held / target * 100) : 0}%)${over}`);
  }

  /** Chunks still to fetch to reach the slider's setting; 0 when it is reached. */
  chunksToReachTarget() {
    return Math.max(0, Math.ceil((this.storageTargetBytes - this.storage.byteCount) / ConsensusConstants.DATA_CHUNK_SIZE));
  }

  async refreshStorageNote() {
    const estimate = await PackedChunkStore.estimate();
    this.storageQuotaBytes = estimate?.quota ?? null;
    this.refreshStorageSlider();
    this.view.setText('storageNote', estimate
      ? `This site uses ${PageView.formatBytes(estimate.usage ?? 0)} of browser storage, of ${PageView.formatBytes(estimate.quota ?? 0)} allowed.`
      : 'This browser does not report its storage limits.');
    await this.refreshSavedAddresses();
    this.refreshSummary();
  }

  // ---- holding data ----

  static PARTITION_STORAGE_KEY = 'weave-tab-miner.partition';

  /**
   * A partition picked at random once per browser and remembered, so tabs mining with the
   * same (shared) key spread over the weave instead of all packing the same partition:
   * distinct data means more one-chunk tries in all and more range-2 lookups landing on
   * held data. Within the partition, each fetch also starts at a random position.
   */
  browserPartition() {
    const partitionCount = Number((this.session.partitionUpperBound + ConsensusConstants.PARTITION_SIZE - 1n) / ConsensusConstants.PARTITION_SIZE);
    let remembered = null;
    try {
      remembered = localStorage.getItem(HoldingPanel.PARTITION_STORAGE_KEY);
    } catch {
      // Storage refused: a fresh random pick each visit still spreads tabs out.
    }
    // The last partition may be partly filled, and the first few hold chunks that do not
    // fill whole buckets (see Replica29Layout.firstBucketAlignedPartition); the pick avoids both.
    const first = Replica29Layout.firstBucketAlignedPartition();
    if (remembered !== null && Number(remembered) >= first && Number(remembered) < partitionCount) return Number(remembered);
    const picked = first + Math.floor(Math.random() * Math.max(1, partitionCount - 1 - first));
    try {
      localStorage.setItem(HoldingPanel.PARTITION_STORAGE_KEY, String(picked));
    } catch {
      // Not remembered; used for this visit.
    }
    this.view.log(`partition ${picked} picked for this browser, out of ${partitionCount}, so tabs sharing a key hold different data`);
    return picked;
  }

  get partitionNumber() {
    return Number(this.view.elements.partitionInput.value || 0);
  }

  packingProgress(done, total) {
    this.view.setText('packStatus', `Packing: entropy ${done} of ${total} (about a second each; chunks at the same position reuse them)…`);
  }

  /** Fetches and packs toward the storage slider's setting, or `chunkCount` chunks if given. */
  async holdChunks({ chunkCount = null } = {}) {
    if (this.holdStopper) {
      this.view.setText('holdStatus', 'Already fetching; "Stop early" ends it.');
      return;
    }
    if (!this.identity || !this.session) {
      this.view.log('pick an identity and load a block first', 'warn');
      return;
    }
    await this.randomxReady;
    if (this.identity.verificationOnly && !(this.blockOrigin === 'sample' && this.identity.address === this.block.reward_addr)) {
      this.view.setText('holdStatus', 'This address belongs to the sample block\'s miner and is for checking only: packing for it would only help them. Use the shared key, generate one, or load your own.');
      return;
    }
    if (this.blockOrigin === 'sample') {
      await this.holdSampleChunks(chunkCount ?? 1);
    } else {
      const wanted = chunkCount ?? this.chunksToReachTarget();
      if (!wanted) {
        this.view.setText('holdStatus', `Already holding ${PageView.formatBytes(this.storage.byteCount)}, at or over the ${PageView.formatBytes(this.storageTargetBytes)} set in "Storage to use". Move it up to hold more${this.storageTargetSetting === 'max' ? '; it is at the most this browser allows (a browser setting, or more free disk, raises that)' : ''}.`);
        return;
      }
      await this.holdLiveChunks(wanted);
    }
    this.refreshStorageSlider();
    this.refreshSummary();
  }

  /**
   * The sample block's recall chunks, packed for this address: `chunkCount` of its one or
   * two (one by default: the sample shows packing; the second only doubles the wait).
   */
  async holdSampleChunks(chunkCount) {
    const proofs = [['poa', 'recall_byte'], ['poa2', 'recall_byte2']];
    if (this.identity.address === this.block.reward_addr) {
      // The block carries the packed sub-chunk its own miner used, for its own address:
      // real packed data with no packing work, though only that one sub-chunk of each chunk.
      const subChunkIndex = Number(Bytes.toBigInt(Bytes.fromBase64Url(this.block.nonce))) % ConsensusConstants.SUB_CHUNK_COUNT;
      for (const [proof, byteField] of proofs) {
        const packedChunk = new Uint8Array(ConsensusConstants.DATA_CHUNK_SIZE);
        packedChunk.set(Bytes.fromBase64Url(this.block[proof].chunk), subChunkIndex * ConsensusConstants.SUB_CHUNK_SIZE);
        this.storage.add(Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField])), packedChunk);
      }
      this.view.setText('holdStatus', `Holding the block's own packed sub-chunk ${subChunkIndex} of each recall chunk, exactly as its miner held them.`);
      return;
    }
    // Approximation: below the strict data split threshold a chunk's entropy comes from its
    // own end offset, which the block's proof gives only with the block's start offset; the
    // bucket's end is used, so packing there differs from a real miner's (mining still runs).
    const chunks = proofs.slice(0, chunkCount).map(([proof, byteField]) => ({
      bytes: Bytes.fromBase64Url(this.block[proof].unpacked_chunk),
      endOffset: Replica29Layout.bucketEndOffsetForByte(BigInt(this.block[byteField])),
    }));
    await this.packAndHold(chunks);
  }

  static KEPT_ENTROPIES = 32;
  // Requests at once: enough to hide each request's latency, few enough to be polite.
  static CHUNK_FETCH_CONCURRENCY = 6;
  // Chunks packed and saved together (32 MiB), so a long fetch never holds it all in memory.
  static CHUNK_BATCH_SIZE = 128;

  showFetchProgress(progress, heldSoFar) {
    const { elements } = this.view;
    elements.holdProgress.hidden = false;
    elements.holdProgress.value = progress.fetched / progress.wanted;
    const left = isFinite(progress.secondsLeft) ? `, about ${PageView.formatDuration(progress.secondsLeft)} left` : '';
    const skipped = progress.skipped ? `; skipped ${progress.skipped} that no source had` : '';
    this.view.setText('holdStatus', `Fetched ${progress.fetched} of ${progress.wanted} chunks (${PageView.formatBytes(progress.bytes)}) at ${PageView.formatBytes(progress.bytesPerSecond)}/s${left}${skipped}. Packed and saved: ${heldSoFar}.`);
  }

  async holdLiveChunks(wanted) {
    const partitionStart = BigInt(this.partitionNumber) * ConsensusConstants.PARTITION_SIZE;
    if (partitionStart >= this.session.partitionUpperBound) {
      this.view.log(`partition ${this.partitionNumber} is past the end of the weave`, 'error');
      return;
    }
    if (this.partitionNumber < Replica29Layout.firstBucketAlignedPartition()) {
      this.view.log(`partition ${this.partitionNumber} holds the weave's oldest data, whose chunks do not fill whole 256 KiB buckets, which this miner cannot yet hold; choose partition ${Replica29Layout.firstBucketAlignedPartition()} or later`, 'error');
      this.view.setText('holdStatus', `Not fetching: partition ${this.partitionNumber} is too early in the weave. Choose ${Replica29Layout.firstBucketAlignedPartition()} or later under Storage.`);
      return;
    }
    // Chunks at one bucket position in successive sectors share all 32 entropies.
    const firstByte = partitionStart + BigInt(Math.floor(Math.random() * Number(ConsensusConstants.entropySectorSize)));
    const stopper = new AbortController();
    this.holdStopper = stopper;
    this.view.elements.stopHoldButton.hidden = false;
    const fetcher = new ChunkFetcher({ gateway: this.gateway, concurrency: HoldingPanel.CHUNK_FETCH_CONCURRENCY });
    let held = 0;
    let lastProgress = null;
    try {
      const batches = fetcher.batches(Replica29Layout.entropySharingPositions(firstByte, this.session.partitionUpperBound), {
        wanted, batchSize: HoldingPanel.CHUNK_BATCH_SIZE, signal: stopper.signal,
        onProgress: (progress) => { lastProgress = progress; this.showFetchProgress(progress, held); },
        onSkip: (weaveByte, error) => this.view.log(`skipping the chunk at byte ${weaveByte}: no source had it (${error.message.split('\n')[1] ?? error.message})`, 'warn'),
      });
      // Pack each batch while the next one is fetched: packing runs in the RandomX worker,
      // so the page stays free to keep requests going. One batch packs at a time.
      let packing = Promise.resolve();
      for await (const batch of batches) {
        await packing;
        packing = this.packAndHold(batch).then(() => {
          held += batch.length;
          if (lastProgress) this.showFetchProgress(lastProgress, held);
        });
      }
      await packing;
    } finally {
      this.view.elements.stopHoldButton.hidden = true;
      this.view.elements.holdProgress.hidden = true;
      this.holdStopper = null;
    }
    const speed = lastProgress ? ` at ${PageView.formatBytes(lastProgress.bytesPerSecond)}/s` : '';
    this.view.setText('holdStatus', held
      ? `Holding ${held} new chunk${held === 1 ? '' : 's'}${stopper.signal.aborted ? ' (stopped early)' : ''}, fetched${speed}, packed and saved.`
      : 'No chunks could be fetched.');
  }

  stopHolding() {
    this.holdStopper?.abort();
    this.view.setText('holdStatus', 'Stopping: requests already sent will finish, then what arrived is packed and saved.');
  }

  async packAndHold(chunks) {
    const started = performance.now();
    const packer = new ChunkPacker(this.identity, this.entropySource);
    const packed = await packer.packChunks(chunks, (done, total) => this.packingProgress(done, total));
    const entries = packed.map((packedChunk, index) => [chunks[index].endOffset, packedChunk]);
    for (const [endOffset, packedChunk] of entries) this.storage.add(endOffset, packedChunk);
    const seconds = (performance.now() - started) / 1000;
    this.view.setText('packStatus', `Packed ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} in ${seconds.toFixed(0)} s${this.usingRealRandomx ? '' : ' with stand-in packing, which is not saved'}.`);
    this.view.log(`packed ${chunks.length} chunks for ${this.identity.address.slice(0, 8)}…`, 'good');
    await this.saveChunks(entries);
  }
}
