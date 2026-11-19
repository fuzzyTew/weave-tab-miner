// src/mining/identity.js — The address a miner packs for and mines to, with its key when it has one.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { Bytes } from '../core/bytes.js';

export class MiningIdentity {
  /**
   * Who mines. The 32-byte mining address is SHA-256 of the RSA public modulus; it
   * keys both the packing and H0. Mining only needs the address — the wallet (the
   * private key) matters only for signing a block or a transaction.
   */
  constructor(addressBytes, wallet = null, { verificationOnly = false } = {}) {
    if (addressBytes.length !== 32) throw new Error(`mining address must be 32 bytes, got ${addressBytes.length}`);
    this.addressBytes = addressBytes;
    this.wallet = wallet;
    // An address used only to replay a known block (someone else's): never packed for,
    // since anything mined for it would pay them.
    this.verificationOnly = verificationOnly;
  }

  get address() {
    return Bytes.toBase64Url(this.addressBytes);
  }

  static fromAddress(addressText) {
    return new MiningIdentity(Bytes.fromBase64Url(addressText.trim()));
  }

  /** Mine for a wallet's own address (see src/wallet/wallet.js), keeping the wallet for signing. */
  static fromWallet(wallet) {
    return new MiningIdentity(wallet.addressBytes, wallet);
  }
}
