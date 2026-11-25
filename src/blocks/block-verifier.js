// src/blocks/block-verifier.js — checks that a block fetched from a peer is the block its id
// names and was signed by its reward key, so a peer cannot hand the follower a forged one.
import { Bytes } from '../core/bytes.js';
import { Secp256k1 } from '../core/secp256k1.js';
import { BlockHash } from './hash.js';

export class BlockVerifier {
  /**
   * ar_block:verify_signature and the id check nodes make: the id is SHA-384 of the signed
   * hash and the signature (BlockHash.indepHash), and the signature is over the signature
   * preimage by `reward_key`: RSA-PSS (SHA-256, 32-byte salt) for a 512-byte RSA modulus,
   * or secp256k1 for a 33-byte compressed key, checked by recovering the key from the
   * signature and comparing.
   */
  static RSA = { name: 'RSA-PSS', hash: 'SHA-256' };
  static RSA_SALT_LENGTH = 32;
  static SECP256K1_KEY_LENGTH = 33;

  /** Why `block` is not genuine, or null if its id and signature check out. */
  static async problem(block) {
    const id = Bytes.toBase64Url(await BlockHash.indepHash(block));
    if (id !== block.indep_hash) return `its id ${block.indep_hash.slice(0, 12)}… is not the hash of its fields and signature (${id.slice(0, 12)}…)`;
    const preimage = BlockHash.signaturePreimage(block);
    const key = Bytes.fromBase64Url(block.reward_key);
    const signature = Bytes.fromBase64Url(block.signature);
    if (key.length === BlockVerifier.SECP256K1_KEY_LENGTH) return BlockVerifier.secp256k1Problem(preimage, signature, key);
    return BlockVerifier.rsaProblem(preimage, signature, block.reward_key);
  }

  static secp256k1Problem(preimage, signature, key) {
    try {
      return Bytes.equal(Secp256k1.recoverPublicKey(preimage, signature), key) ? null : 'its secp256k1 signature recovers a key other than its reward key';
    } catch (error) {
      return `its secp256k1 signature is malformed: ${error.message}`;
    }
  }

  static async rsaProblem(preimage, signature, modulusBase64Url) {
    const publicKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', e: 'AQAB', n: modulusBase64Url }, BlockVerifier.RSA, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: BlockVerifier.RSA_SALT_LENGTH }, publicKey, signature, preimage);
    return valid ? null : 'its RSA signature does not verify with its reward key';
  }
}
