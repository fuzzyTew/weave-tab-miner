// src/blocks/signer.js — signs a finished block with the miner's key, never twice for one
// place in the chain: a DoubleSigningGuard is consulted before every signature.
import { Bytes } from '../core/bytes.js';
import { BlockHash } from './hash.js';

export class BlockSigner {
  /**
   * `key` is a block key: { address, addressBytes, ownerBytes (what goes in reward_key),
   * sign(preimage) → Promise<signature bytes> }. An ArweaveWallet is one (RSA-4096,
   * RSA-PSS with SHA-256: the node verifies PSS with any salt length). A secp256k1 key,
   * which the node also accepts since 2.9 (33-byte reward_key, 65-byte recoverable
   * signature over SHA-256 of the preimage; BlockVerifier checks such blocks), or a
   * threshold signer could fill the same shape. `guard` is a DoubleSigningGuard.
   */
  constructor({ key, guard }) {
    Object.assign(this, { key, guard });
  }

  /**
   * Fills reward_addr, reward_key, signature and indep_hash on a copy of `block` (block
   * JSON with every other field set) and returns it. Throws, signing nothing, if this key
   * has signed a competing block.
   */
  async sign(block) {
    const signed = { ...block, reward_addr: this.key.address, reward_key: Bytes.toBase64Url(this.key.ownerBytes) };
    const blockHash = Bytes.toBase64Url(BlockHash.signedHash(signed));
    const candidate = {
      height: signed.height, cumulativeDiff: BigInt(signed.cumulative_diff),
      previousCumulativeDiff: BigInt(signed.previous_cumulative_diff), blockHash,
    };
    const conflict = this.guard.conflictFor(this.key.address, candidate);
    if (conflict) throw new Error(`refusing to sign: this key already signed a competing block at height ${conflict.height} (signed hash ${conflict.blockHash.slice(0, 12)}…), and a second signature would get the address banned; mining resumes once the chain moves past that height`);
    // Recorded before signing, so a crash in between can never leave an unrecorded signature.
    this.guard.record(this.key.address, candidate);
    signed.signature = Bytes.toBase64Url(await this.key.sign(BlockHash.signaturePreimage(signed)));
    signed.indep_hash = Bytes.toBase64Url(await BlockHash.indepHash(signed));
    return signed;
  }
}
