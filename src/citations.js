// src/citations.js — where each mining rule lives in the Arweave node source, so every
// value the miner computes can be checked against the code it imitates.

export class SourceCitations {
  /**
   * Links into ArweaveTeam/arweave at the commit this miner was written against, plus the
   * RandomX pieces. Line numbers are for that commit; a later commit may move them.
   */
  static ARWEAVE_COMMIT = '18d402c714132e1de3962b12ff32a420127e0c02';
  static ARWEAVE_BASE = `https://github.com/ArweaveTeam/arweave/blob/${SourceCitations.ARWEAVE_COMMIT}/apps/arweave/`;
  static RANDOMX_FORK_BASE = 'https://github.com/ArweaveTeam/RandomX/blob/eef4dc8/';

  static RULES = {
    h0: { file: 'src/ar_block.erl', lines: [230, 246], what: 'H0 = RandomX(VDF output ‖ partition number (32 bytes) ‖ seed (32 bytes) ‖ mining address ‖ packing difficulty (1 byte))' },
    h0Seed: { file: 'src/ar_block.erl', lines: [215, 222], what: 'the seed is the previous block\'s nonce_limiter_info.seed' },
    h0RandomxState: { file: 'src/ar_packing_server.erl', lines: [220, 230], what: 'H0 uses the "rx4096" RandomX state, keyed with RANDOMX_PACKING_KEY' },
    packingKey: { file: 'include/ar_consensus.hrl', lines: [191, 191], what: 'RANDOMX_PACKING_KEY = "default arweave 2.5 pack key"' },
    randomxVariant: { file: 'lib/Makefile', lines: [1, 40], what: 'Arweave\'s RandomX builds: rx512, rx4096 (H0) and squared (packing)' },
    recallRange: { file: 'src/ar_block.erl', lines: [624, 646], what: 'range 1 starts inside your partition at H0\'s first 8 bytes mod the partition size; range 2 at all of H0 mod the weave size' },
    recallRangeSize: { file: 'include/ar_consensus.hrl', lines: [92, 94], what: 'RECALL_RANGE_SIZE, divided by the packing difficulty of 10' },
    recallByte: { file: 'src/ar_block.erl', lines: [671, 676], what: 'nonce → chunk (nonce div 32) and sub-chunk (nonce rem 32)' },
    h1: { file: 'src/ar_block.erl', lines: [248, 250], what: 'H1 = SHA-256(H0 ‖ SHA-256(H0 ‖ nonce (8 bytes) ‖ packed sub-chunk 1))' },
    h2: { file: 'src/ar_block.erl', lines: [253, 255], what: 'H2 = SHA-256(H0 ‖ SHA-256(H1 ‖ packed sub-chunk 2))' },
    solutionHash: { file: 'src/ar_block.erl', lines: [258, 259], what: 'solution hash = SHA-256(H0 ‖ preimage)' },
    diffCheck: { file: 'src/ar_node_utils.erl', lines: [143, 170], what: 'a hash passes when, as a big-endian integer, it exceeds the scaled difficulty' },
    subDiff: { file: 'src/ar_difficulty.erl', lines: [77, 125], what: 'difficulty split across 32 sub-chunks, eased by the packing difficulty; one-chunk solutions 100 times harder' },
    poa1Multiplier: { file: 'include/ar_consensus.hrl', lines: [135, 135], what: 'POA1_DIFF_MULTIPLIER = 100' },
    entropyKey: { file: 'src/ar_replica_2_9.erl', lines: [193, 204], what: 'entropy key = SHA-256(entropy partition ‖ entropy index ‖ mining address)' },
    entropyIndex: { file: 'src/ar_replica_2_9.erl', lines: [246, 260], what: 'entropy index: the chunk\'s bucket within its sector × 32 + sub-chunk number' },
    sliceIndex: { file: 'src/ar_replica_2_9.erl', lines: [205, 215], what: 'slice index: which 8 KiB of the 8 MiB entropy, from the chunk\'s sector' },
    packingXor: { file: 'src/ar_packing_server.erl', lines: [874, 880], what: 'packed sub-chunk = sub-chunk XOR its entropy slice' },
    rx2Entropy: { file: 'c_src/randomx/randomx_squared.cpp', lines: [158, 254], what: 'the 8 MiB entropy: 4 lanes × 2 MiB, 3 rounds of 6 RandomX programs, CRC-32C near mix, 6-byte far mix' },
    vdfStep: { file: 'src/ar_vdf.erl', lines: [10, 30], what: 'a VDF step = 25 checkpoints of salted, chained SHA-256' },
    vdfHashing: { file: 'c_src/vdf/vdf.cpp', lines: [56, 90], what: 'each checkpoint hashes (salt ‖ previous) repeatedly; the salt is a 256-bit counter' },
    vdfReset: { file: 'src/ar_nonce_limiter.erl', lines: [314, 316], what: 'every 1200 steps, fresh entropy is mixed in' },
    vdfServer: { file: 'src/ar_http_iface_middleware.erl', lines: [3363, 3376], what: 'GET /vdf answers only public VDF servers\' callers or configured clients' },
    peerCors: { file: 'src/ar_http_iface_middleware.erl', lines: [195, 206], what: 'every node response carries CORS headers, so browsers may read it' },
  };

  static url(ruleName) {
    const rule = SourceCitations.RULES[ruleName];
    if (!rule) throw new Error(`no citation named ${ruleName}`);
    const [first, last] = rule.lines;
    return `${SourceCitations.ARWEAVE_BASE}${rule.file}#L${first}${last !== first ? `-L${last}` : ''}`;
  }

  static label(ruleName) {
    const rule = SourceCitations.RULES[ruleName];
    const [first, last] = rule.lines;
    return `${rule.file.split('/').pop()}:${first}${last !== first ? `–${last}` : ''}`;
  }
}
