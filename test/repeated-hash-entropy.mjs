// test/repeated-hash-entropy.mjs — quick stand-in entropy for tests of packing logic.
import { Sha256 } from '../src/core/sha256.js';
import { ConsensusConstants } from '../src/core/constants.js';

/**
 * Entropy for checking XOR and layout logic only: SHA-256 of the key, repeated to 8 MiB by
 * doubling copies. Each sub-chunk needs its own 8 MiB, so this is far quicker than the
 * page's StubEntropySource (whose output must not change, since browsers keep chunks
 * packed with it).
 */
export class RepeatedHashEntropySource {
  isStub = true;

  async entropy(entropyKey) {
    const entropy = new Uint8Array(ConsensusConstants.REPLICA_2_9_ENTROPY_SIZE);
    entropy.set(Sha256.hash(entropyKey));
    for (let filled = 32; filled < entropy.length; filled *= 2) entropy.copyWithin(filled, 0, filled);
    return entropy;
  }
}
