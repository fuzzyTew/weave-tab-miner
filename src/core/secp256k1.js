// src/core/secp256k1.js — the secp256k1 elliptic curve, enough to recover a signer's public key
// from a signature, as Arweave nodes do for transactions signed with such keys (their owner
// field is left empty; ar_wallet:recover_key). Plain BigInt arithmetic: a few milliseconds
// per recovery, fine for the handful of such transactions in a block. It recovers keys
// only; nothing here signs, so timing leaks do not matter.
import { Bytes } from './bytes.js';
import { Sha256 } from './sha256.js';

export class Secp256k1 {
  /** The curve y² = x³ + 7 over the prime field P; G generates the group of prime order N. */
  static P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  static N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  static G = {
    x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  };

  static mod(value, modulus) {
    const result = value % modulus;
    return result >= 0n ? result : result + modulus;
  }

  /** value^exponent mod modulus, by squaring. */
  static power(value, exponent, modulus) {
    let result = 1n;
    let base = Secp256k1.mod(value, modulus);
    for (let rest = exponent; rest > 0n; rest >>= 1n) {
      if (rest & 1n) result = (result * base) % modulus;
      base = (base * base) % modulus;
    }
    return result;
  }

  /** The multiplicative inverse, by Fermat's little theorem (the moduli are prime). */
  static inverse(value, modulus) {
    return Secp256k1.power(value, modulus - 2n, modulus);
  }

  /** Affine point addition; null is the point at infinity. */
  static add(left, right) {
    const { P, mod, inverse } = Secp256k1;
    if (!left) return right;
    if (!right) return left;
    if (left.x === right.x && mod(left.y + right.y, P) === 0n) return null;
    const slope = left.x === right.x
      ? mod(3n * left.x * left.x * inverse(2n * left.y, P), P)
      : mod((right.y - left.y) * inverse(mod(right.x - left.x, P), P), P);
    const x = mod(slope * slope - left.x - right.x, P);
    return { x, y: mod(slope * (left.x - x) - left.y, P) };
  }

  static multiply(point, scalar) {
    let result = null;
    let addend = point;
    for (let rest = Secp256k1.mod(scalar, Secp256k1.N); rest > 0n; rest >>= 1n) {
      if (rest & 1n) result = Secp256k1.add(result, addend);
      addend = Secp256k1.add(addend, addend);
    }
    return result;
  }

  /** The 33-byte compressed form: 02 or 03 (y even or odd), then x. */
  static compressed(point) {
    return Bytes.concat(new Uint8Array([point.y & 1n ? 3 : 2]), Bytes.fromBigInt(point.x, 32));
  }

  /**
   * The compressed public key that made `signature` (r ‖ s ‖ recovery id, 65 bytes) over
   * SHA-256 of `message`, as the node's secp256k1_nif:ecrecover. The recovery id's low bit
   * is R's y parity; its second bit (r ≥ N, rarer than 1 in 2^127) is accepted too.
   */
  static recoverPublicKey(message, signature) {
    const { P, N, G, mod, power, inverse } = Secp256k1;
    if (signature.length !== 65) throw new Error(`a secp256k1 signature is 65 bytes, not ${signature.length}`);
    const r = Bytes.toBigInt(signature.subarray(0, 32));
    const s = Bytes.toBigInt(signature.subarray(32, 64));
    const recoveryId = signature[64];
    if (r === 0n || r >= N || s === 0n || s >= N || recoveryId > 3) throw new Error('not a valid secp256k1 signature');
    const x = recoveryId & 2 ? r + N : r;
    // P ≡ 3 (mod 4), so a square root is the (P + 1)/4 power.
    let y = power(x * x * x + 7n, (P + 1n) / 4n, P);
    if (mod(y * y, P) !== mod(x * x * x + 7n, P)) throw new Error('the signature names no point on the curve');
    if ((y & 1n) !== BigInt(recoveryId & 1)) y = P - y;
    const digest = Bytes.toBigInt(Sha256.hash(message));
    const rInverse = inverse(r, N);
    const key = Secp256k1.add(Secp256k1.multiply({ x, y }, mod(s * rInverse, N)), Secp256k1.multiply(G, mod(-digest * rInverse, N)));
    if (!key) throw new Error('the signature recovers no key');
    return Secp256k1.compressed(key);
  }
}
