// src/core/bytes.js — Byte array helpers: concatenation, base64url, hex and big-integer conversion.
// Part of the library split from the original src/mining/; see README.md "Layout".

export class Bytes {
  /**
   * Byte-array helpers. Arweave's JSON uses base64url without padding; big integers
   * are big-endian ("network order"), as in Erlang's <<N:256>>.
   */
  static fromBase64Url(text) {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  static toBase64Url(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  static toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  static concat(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let position = 0;
    for (const part of parts) {
      joined.set(part, position);
      position += part.length;
    }
    return joined;
  }

  static fromBigInt(value, byteCount) {
    const bytes = new Uint8Array(byteCount);
    for (let index = byteCount - 1; index >= 0; index--) {
      bytes[index] = Number(value & 0xffn);
      value >>= 8n;
    }
    return bytes;
  }

  /**
   * binary:encode_unsigned: big-endian with no leading zeros, and one zero byte for 0.
   * Values up to 2^53 use double arithmetic, several times faster than BigInt steps.
   */
  static unsignedBigEndian(value) {
    value = BigInt(value);
    if (value < 0n) throw new Error(`${value} is negative, so it has no unsigned encoding`);
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      let number = Number(value);
      let length = 1;
      while (number >= 256 ** length) length++;
      const bytes = new Uint8Array(length);
      for (let index = length - 1; index >= 0; index--) {
        bytes[index] = number % 256;
        number = Math.floor(number / 256);
      }
      return bytes;
    }
    let hex = value.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  }

  static toBigInt(bytes) {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
  }

  static equal(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
    return true;
  }
}
