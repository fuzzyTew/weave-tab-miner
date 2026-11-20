// src/core/sha384.js — SHA-384 (FIPS 180-4) in plain JavaScript, synchronous. WebCrypto's digest
// is asynchronous, and hashing an account tree takes millions of small hashes, where
// awaiting each costs far more than the hash. 64-bit words are kept as high and low 32-bit
// halves, since JavaScript has no fast 64-bit integers.

export class Sha384 {
  /** SHA-512's round constants, as [high, low] 32-bit halves. */
  static K = [
    0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538,
    0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe,
    0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235,
    0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
    0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab,
    0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
    0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed,
    0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
    0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218,
    0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53,
    0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373,
    0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
    0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c,
    0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
    0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc,
    0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
  ];

  /** SHA-384's initial state (the first 64 bits of the fractional parts of the square roots of primes 9–16), halves. */
  static INITIAL = [
    0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
    0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4,
  ];

  static words = new Int32Array(160);

  /** SHA-384 of `bytes` (a Uint8Array), as 48 bytes. */
  static hash(bytes) {
    const length = bytes.length;
    const blockCount = Math.ceil((length + 17) / 128); // data, the 0x80 byte, and a 16-byte length
    const padded = new Uint8Array(blockCount * 128);
    padded.set(bytes);
    padded[length] = 0x80;
    // The bit length in the last 16 bytes; lengths here stay far under 2^53 bits.
    const bitLength = length * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
    view.setUint32(padded.length - 4, bitLength >>> 0);

    const state = Int32Array.from(Sha384.INITIAL);
    const words = Sha384.words;
    const K = Sha384.K;
    for (let block = 0; block < blockCount; block++) {
      for (let index = 0; index < 32; index++) words[index] = view.getInt32(block * 128 + index * 4);
      for (let index = 32; index < 160; index += 2) {
        // σ0 of word i−15 and σ1 of word i−2, each on 64-bit halves.
        let high = words[index - 30];
        let low = words[index - 29];
        const sigma0High = ((high >>> 1) | (low << 31)) ^ ((high >>> 8) | (low << 24)) ^ (high >>> 7);
        const sigma0Low = ((low >>> 1) | (high << 31)) ^ ((low >>> 8) | (high << 24)) ^ ((low >>> 7) | (high << 25));
        high = words[index - 4];
        low = words[index - 3];
        const sigma1High = ((high >>> 19) | (low << 13)) ^ ((low >>> 29) | (high << 3)) ^ (high >>> 6);
        const sigma1Low = ((low >>> 19) | (high << 13)) ^ ((high >>> 29) | (low << 3)) ^ ((low >>> 6) | (high << 26));
        const sumLow = (sigma0Low >>> 0) + (sigma1Low >>> 0) + (words[index - 13] >>> 0) + (words[index - 31] >>> 0);
        words[index] = (sigma0High + sigma1High + words[index - 14] + words[index - 32] + Math.floor(sumLow / 2 ** 32)) | 0;
        words[index + 1] = sumLow | 0;
      }

      let [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl] = state;
      for (let round = 0; round < 160; round += 2) {
        // Σ1(e), Ch(e, f, g), then T1 = h + Σ1 + Ch + K + W.
        const sigma1High = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
        const sigma1Low = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
        const chooseHigh = (eh & fh) ^ (~eh & gh);
        const chooseLow = (el & fl) ^ (~el & gl);
        const t1Low = (hl >>> 0) + (sigma1Low >>> 0) + (chooseLow >>> 0) + (K[round + 1] >>> 0) + (words[round + 1] >>> 0);
        const t1High = (hh + sigma1High + chooseHigh + K[round] + words[round] + Math.floor(t1Low / 2 ** 32)) | 0;
        // Σ0(a), Maj(a, b, c), then T2 = Σ0 + Maj.
        const sigma0High = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
        const sigma0Low = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
        const majorityHigh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
        const majorityLow = (al & bl) ^ (al & cl) ^ (bl & cl);
        const t2Low = (sigma0Low >>> 0) + (majorityLow >>> 0);
        const t2High = (sigma0High + majorityHigh + Math.floor(t2Low / 2 ** 32)) | 0;

        hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
        const eLow = (dl >>> 0) + (t1Low >>> 0);
        eh = (dh + t1High + Math.floor(eLow / 2 ** 32)) | 0;
        el = eLow | 0;
        dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
        const aLow = (t1Low >>> 0) + (t2Low >>> 0);
        ah = (t1High + t2High + Math.floor(aLow / 2 ** 32)) | 0;
        al = aLow | 0;
      }
      const results = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
      for (let index = 0; index < 16; index += 2) {
        const low = (state[index + 1] >>> 0) + (results[index + 1] >>> 0);
        state[index] = (state[index] + results[index] + Math.floor(low / 2 ** 32)) | 0;
        state[index + 1] = low | 0;
      }
    }
    const digest = new Uint8Array(48);
    const digestView = new DataView(digest.buffer);
    for (let index = 0; index < 12; index++) digestView.setInt32(index * 4, state[index]);
    return digest;
  }
}
