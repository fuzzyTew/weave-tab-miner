// src/core/sha256.js — SHA-256 in plain JavaScript (synchronous, unlike WebCrypto), with a fast path for 64-byte inputs.
// Part of the library split from the original src/mining/; see README.md "Layout".
import { Bytes } from './bytes.js';

export class Sha256 {
  /**
   * Synchronous SHA-256 in plain JavaScript. WebCrypto only offers an asynchronous
   * digest, which is far too slow for the VDF's millions of chained hashes, so this
   * class computes it directly. digest64() is a fast path for exactly 64-byte inputs:
   * their padding block is the same every time, so its message schedule (the 64
   * expanded words SHA-256 derives from each block) is computed once and reused.
   */
  static ROUND_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  static INITIAL_STATE = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  constructor() {
    this.schedule = new Uint32Array(64);
    this.state = new Uint32Array(8);
    this.paddingSchedule64 = Sha256.expandedPaddingScheduleForLength(64);
  }

  static expandedPaddingScheduleForLength(messageByteLength) {
    // The final block for a message that exactly fills whole blocks: a 1 bit, zeros,
    // then the message length in bits.
    const schedule = new Uint32Array(64);
    schedule[0] = 0x80000000;
    schedule[15] = messageByteLength * 8;
    Sha256.expandSchedule(schedule);
    return schedule;
  }

  static expandSchedule(schedule) {
    for (let index = 16; index < 64; index++) {
      const word15 = schedule[index - 15];
      const word2 = schedule[index - 2];
      const sigma0 = ((word15 >>> 7) | (word15 << 25)) ^ ((word15 >>> 18) | (word15 << 14)) ^ (word15 >>> 3);
      const sigma1 = ((word2 >>> 17) | (word2 << 15)) ^ ((word2 >>> 19) | (word2 << 13)) ^ (word2 >>> 10);
      schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) | 0;
    }
  }

  static compress(state, schedule) {
    const constants = Sha256.ROUND_CONSTANTS;
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let round = 0; round < 64; round++) {
      const sum1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + constants[round] + schedule[round]) | 0;
      const sum0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
    state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0;
    state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
  }

  loadBlockWords(bytes, offset) {
    for (let word = 0; word < 16; word++) {
      const at = offset + word * 4;
      this.schedule[word] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    }
    Sha256.expandSchedule(this.schedule);
  }

  writeState(output, outputOffset = 0) {
    for (let word = 0; word < 8; word++) {
      const value = this.state[word];
      output[outputOffset + word * 4] = value >>> 24;
      output[outputOffset + word * 4 + 1] = (value >>> 16) & 0xff;
      output[outputOffset + word * 4 + 2] = (value >>> 8) & 0xff;
      output[outputOffset + word * 4 + 3] = value & 0xff;
    }
  }

  /** Hash exactly 64 input bytes into output (32 bytes); output may alias input. */
  digest64(input, output) {
    this.state.set(Sha256.INITIAL_STATE);
    this.loadBlockWords(input, 0);
    Sha256.compress(this.state, this.schedule);
    Sha256.compress(this.state, this.paddingSchedule64);
    this.writeState(output);
    return output;
  }

  /** Hash any byte array; returns a new 32-byte array. */
  digest(input) {
    const bitLength = BigInt(input.length) * 8n;
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(input);
    padded[input.length] = 0x80;
    padded.set(Bytes.fromBigInt(bitLength, 8), paddedLength - 8);
    this.state.set(Sha256.INITIAL_STATE);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      this.loadBlockWords(padded, offset);
      Sha256.compress(this.state, this.schedule);
    }
    const output = new Uint8Array(32);
    this.writeState(output);
    return output;
  }

  static hash(...parts) {
    return Sha256.shared.digest(Bytes.concat(...parts));
  }
}
Sha256.shared = new Sha256();
