// arweave_wallet.js — an Arweave RSA key held in memory, made or loaded with WebCrypto.
import { Bytes, Sha256 } from './arweave_miner.js';

export class ArweaveWallet {
  /**
   * An Arweave key: RSA-4096, signing with RSA-PSS over SHA-256 with a 32-byte salt
   * (as arweave-js does). The address is SHA-256 of the public modulus; the "owner"
   * field of a transaction is the modulus itself. Nothing here is saved anywhere.
   */
  static ALGORITHM = { name: 'RSA-PSS', hash: 'SHA-256' };
  static SALT_LENGTH = 32;

  constructor({ privateKey, publicJwk }) {
    this.privateKey = privateKey;
    this.publicJwk = publicJwk;
    this.ownerBytes = Bytes.fromBase64Url(publicJwk.n);
    this.addressBytes = Sha256.hash(this.ownerBytes);
  }

  get address() {
    return Bytes.toBase64Url(this.addressBytes);
  }

  get owner() {
    return this.publicJwk.n;
  }

  /** Make a new key. Takes a few seconds; RSA key generation is slow. */
  static async generate() {
    const keyPair = await crypto.subtle.generateKey(
      { ...ArweaveWallet.ALGORITHM, modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']);
    return new ArweaveWallet({ privateKey: keyPair.privateKey, publicJwk: await crypto.subtle.exportKey('jwk', keyPair.publicKey) });
  }

  /** Load an Arweave keyfile (the JWK JSON that wallets export). */
  static async fromJwk(jwk) {
    const privateJwk = { kty: 'RSA', e: jwk.e, n: jwk.n, d: jwk.d, p: jwk.p, q: jwk.q, dp: jwk.dp, dq: jwk.dq, qi: jwk.qi, ext: true };
    const privateKey = await crypto.subtle.importKey('jwk', privateJwk, ArweaveWallet.ALGORITHM, true, ['sign']);
    return new ArweaveWallet({ privateKey, publicJwk: { kty: 'RSA', e: jwk.e, n: jwk.n } });
  }

  /** The full keyfile, for a backup the person chooses to keep. */
  async exportJwk() {
    return crypto.subtle.exportKey('jwk', this.privateKey);
  }

  async sign(messageBytes) {
    return new Uint8Array(await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: ArweaveWallet.SALT_LENGTH }, this.privateKey, messageBytes));
  }
}
