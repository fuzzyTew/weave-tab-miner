// apps/browser/quick-start-panel.js — one button that takes a visitor from nothing to mining:
// an identity, sources that answer, the live block, some packed data, and a VDF source.
// Its methods are mixed into BrowserNodeApp (see app.js), so `this` is the app.
import { VdfServerClient } from '../../src/network/vdf-client.js';
import { PeerAccess } from '../../src/network/peers.js';

export class QuickStartPanel {
  // Packed data to fetch when nothing is held yet: 64 chunks (16 MiB), a few minutes of
  // fetching and about half a minute of packing, after which more can be added any time.
  static QUICK_START_CHUNKS = 64;

  /** One line per stage in the quick-start list: ✓ done, ✗ stopped there, … under way. */
  quickStartStage(text, state = 'working') {
    const list = this.view.elements.quickStartStages;
    const item = document.createElement('li');
    item.className = `quick-start-${state}`;
    item.textContent = `${{ working: '…', done: '✓', failed: '✗', note: '·' }[state]} ${text}`;
    const previous = list.lastElementChild;
    if (previous?.classList.contains('quick-start-working')) {
      // A finished stage is replaced by its result; one followed by the next stage is marked done.
      if (state === 'working') {
        previous.className = 'quick-start-done';
        previous.textContent = previous.textContent.replace(/^… /, '✓ ').replace(/…$/, '');
      } else {
        previous.remove();
      }
    }
    list.append(item);
  }

  /**
   * Mines for the identity already chosen if it is a real one, otherwise for the shared key.
   * Each stage reuses what earlier visits left (tested sources, saved chunks) and says what
   * it chose, so the person can see why and change any part in the sections below.
   */
  async quickStart() {
    const button = this.view.elements.quickStartButton;
    button.disabled = true;
    this.view.elements.quickStartStages.replaceChildren();
    try {
      if (this.running) this.stop();

      if (!this.identity || this.identity.verificationOnly) await this.useSharedKey();
      this.quickStartStage(`Mining for ${this.identity.wallet && this.identity.address === this.sharedKeyAddress() ? 'the shared key' : 'your address'} ${this.identity.address.slice(0, 8)}…`, 'done');

      if (!this.sourcesTested) {
        this.quickStartStage('Testing gateways and nodes…');
        await this.testSources();
        this.sourcesTested = true;
      }
      this.quickStartStage('Fetching the current block…');
      if (!(await this.loadLiveBlock())) {
        this.quickStartStage('Could not reach Arweave from this network. Open "Notes" above, under "If this network blocks Arweave": another network, a hotspot, or your own gateway in Network.', 'failed');
        return;
      }
      this.quickStartStage(`Current block ${this.session.height.toLocaleString()}, partition ${this.partitionNumber}`, 'done');

      await this.randomxReady;
      const savedElsewhere = (await this.store.addresses()).filter(({ address }) => address !== this.identity.address);
      if (this.storage.bytesInPartition(this.partitionNumber) === 0 && savedElsewhere.length === 0) {
        this.quickStartStage(`Fetching and packing ${QuickStartPanel.QUICK_START_CHUNKS} chunks (16 MiB) to start with…`);
        await this.holdChunks({ chunkCount: Math.min(QuickStartPanel.QUICK_START_CHUNKS, this.chunksToReachTarget() || QuickStartPanel.QUICK_START_CHUNKS) });
      }
      const heldChunks = this.storage.packedChunks.size;
      if (savedElsewhere.length) this.quickStartStage(`Chunks saved for ${savedElsewhere.length} other address${savedElsewhere.length === 1 ? '' : 'es'} will be repacked for this one first`, 'note');
      if (!heldChunks && !savedElsewhere.length) {
        this.quickStartStage('No chunks could be fetched. Network has a source test; Hold data can try again.', 'failed');
        return;
      }
      this.quickStartStage(`Holding ${heldChunks} chunk${heldChunks === 1 ? '' : 's'}`, 'done');

      this.quickStartStage('Looking for a VDF server…');
      const client = new VdfServerClient({ baseUrls: this.vdfServerCandidates(), log: () => {} });
      if (await client.findServer()) {
        this.view.elements.vdfModeServer.checked = true;
        this.quickStartStage(`VDF steps from ${client.serverUrl}`, 'done');
      } else {
        this.view.elements.vdfModeLocal.checked = true;
        const hint = PeerAccess.blockedReason() ? ' (on this https copy, tick "insecure content allowed" in Network, or use a downloaded copy, to reach the public servers)' : '';
        this.quickStartStage(`No VDF server answered${hint}; computing steps in this tab, which uses a whole CPU core`, 'done');
      }
      await this.start();
      this.quickStartStage('Mining. The wait and what limits it are under "Why the wait is this long".', 'done');
      const blocker = this.publishBlocker();
      this.quickStartStage(blocker ? `A solution would not be published: ${blocker}` : 'Getting ready to publish any solution as a block (see "Publishing" in Mine).', blocker ? 'note' : 'done');
    } catch (error) {
      this.quickStartStage(`Stopped: ${error.message.split('\n')[0]}`, 'failed');
      this.view.log(`quick start: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }
}
