// apps/browser/records-panel.js — A wallet's balance and history, and storing a record.
// Its methods are mixed into BrowserNodeApp (see app.js), so `this` is the app.
import { Miner } from '../../src/mining/miner.js';
import { DataTransaction } from '../../src/wallet/transaction.js';
import { DataItem, TurboUploader } from '../../src/wallet/bundle.js';
import { PageView } from './page-view.js';

export class RecordsPanel {
  // ---- wallet lookup ----

  async lookUpWallet() {
    const address = this.view.elements.walletAddressInput.value.trim();
    this.view.setText('walletStatus', `Looking up ${address.slice(0, 8)}…`);
    try {
      const [balance, reserved, history, latestSent] = await Promise.allSettled([
        this.gateway.balanceWinston(address), this.gateway.reservedRewardsWinston(address), this.gateway.transactionHistory(address),
        this.gateway.latestSentTransaction(address),
      ]);
      this.view.setText('walletBalance', balance.status === 'fulfilled' ? PageView.formatAr(balance.value) : 'unavailable');
      this.view.setText('walletReserved', reserved.status === 'fulfilled' ? PageView.formatAr(reserved.value) : 'unavailable from these gateways');
      // From the node protocol itself, so it does not depend on a gateway's index.
      if (latestSent.status === 'fulfilled') {
        const { id, confirmedAtHeight } = latestSent.value;
        const element = this.view.elements.walletLatestSent;
        element.replaceChildren();
        if (!id) {
          element.textContent = 'none (bundled items do not show here)';
        } else {
          const link = document.createElement('a');
          Object.assign(link, { href: `https://arweave.net/tx/${id}`, target: '_blank', rel: 'noopener', textContent: id });
          element.append(link, confirmedAtHeight ? `, in block ${confirmedAtHeight.toLocaleString()}` : ', not confirmed yet');
        }
      } else {
        this.view.setText('walletLatestSent', 'unavailable');
      }
      if (history.status === 'fulfilled') {
        this.view.fillHistory('walletSent', history.value.sent, 'nothing sent');
        this.view.fillHistory('walletReceived', history.value.received, 'nothing received');
      }
      const failed = [balance, reserved, history, latestSent].filter((result) => result.status === 'rejected');
      for (const result of failed) this.view.log(result.reason.message.split('\n')[0], 'error');
      this.view.setText('walletStatus', failed.length === 4 ? 'Nothing answered.' : `Checked at ${new Date().toLocaleTimeString()}.`);
    } catch (error) {
      this.view.setText('walletStatus', `Lookup failed: ${error.message}`);
    }
  }

  // ---- storing a record ----

  recordBytes() {
    return new TextEncoder().encode(this.view.elements.recordInput.value);
  }

  async quoteRecord() {
    const byteCount = this.recordBytes().length;
    try {
      const winston = await this.gateway.priceWinston(byteCount);
      this.view.setText('recordStatus', `${byteCount} bytes would cost ${PageView.formatAr(winston)} right now.`);
      return winston;
    } catch (error) {
      this.view.setText('recordStatus', 'Could not get a price; nothing answered.');
      this.view.log(error.message.split('\n')[0], 'error');
      return null;
    }
  }

  async sendRecord() {
    const wallet = this.identity?.wallet;
    if (!wallet) {
      this.view.setText('recordStatus', 'Sending needs a key: generate one or load a keyfile in Identity. An address alone cannot sign.');
      return;
    }
    const rewardWinston = await this.quoteRecord();
    if (rewardWinston === null) return;
    try {
      const anchor = await this.gateway.transactionAnchor();
      const transaction = await new DataTransaction({
        data: this.recordBytes(), anchor, rewardWinston,
        tags: [['Content-Type', 'text/plain; charset=utf-8'], ['App-Name', 'Weave-Tab-Miner']],
      }).sign(wallet);
      this.view.setText('recordStatus', `Signed ${transaction.id}. Sending…`);
      const reply = await this.gateway.postTransaction(transaction.toJson());
      this.view.setText('recordStatus', `Sent to ${this.gateway.lastAnsweredBy}, which replied "${reply.slice(0, 80)}". It should be readable at arweave.net/${transaction.id} within minutes.`);
      this.view.elements.recordLink.href = `https://arweave.net/${transaction.id}`;
      this.view.elements.recordLink.textContent = `arweave.net/${transaction.id}`;
      this.view.log(`record transaction ${transaction.id} sent`, 'good');
    } catch (error) {
      const lacksFunds = /balance|funds|insufficient/i.test(error.message);
      this.view.setText('recordStatus', lacksFunds ? 'Refused: this key has no AR to pay the fee yet.' : `Not sent: ${error.message.split('\n')[0]}`);
      this.view.log(error.message.split('\n')[0], 'error');
    }
  }

  /**
   * The record as an ANS-104 item signed by this key, handed to Turbo's free tier. The id
   * is fixed by the signature here, so it can be looked up on any gateway once bundled.
   */
  async sendRecordFree() {
    const wallet = this.identity?.wallet;
    if (!wallet) {
      this.view.setText('recordStatus', 'Storing needs a key to sign with: generate one or load a keyfile in Identity. It needs no AR.');
      return;
    }
    const data = this.recordBytes();
    if (data.length > TurboUploader.FREE_BYTES - 2048) {
      this.view.setText('recordStatus', `${data.length} bytes is too big for Turbo's free tier (100 KiB including about 1 KiB of signature and tags).`);
      return;
    }
    try {
      const item = await new DataItem({ data, tags: [['Content-Type', 'text/plain; charset=utf-8'], ['App-Name', 'Weave-Tab-Miner']] }).sign(wallet);
      this.view.setText('recordStatus', `Signed item ${item.id}. Sending to Turbo…`);
      const receipt = await new TurboUploader().upload(item);
      if (receipt.id !== item.id) throw new Error(`Turbo answered for a different id, ${receipt.id}`);
      this.view.setText('recordStatus', `Turbo accepted ${item.id}${receipt.winc === '0' ? ' for free' : ` and charged ${receipt.winc} winc`}. It should be readable at arweave.net/${item.id} soon, and in a block once Turbo bundles it.`);
      this.view.elements.recordLink.href = `https://arweave.net/${item.id}`;
      this.view.elements.recordLink.textContent = `arweave.net/${item.id}`;
      this.view.log(`Turbo receipt: ${JSON.stringify(receipt).slice(0, 400)}`, 'good');
    } catch (error) {
      this.view.setText('recordStatus', `Not stored: ${error.message.split('\n')[0]}`);
      this.view.log(error.message.split('\n')[0], 'error');
    }
  }
}
