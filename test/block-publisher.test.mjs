// test/block-publisher.test.mjs — BlockPublisher end to end against the saved localnet blocks: from
// each block's parent state and a miner-style report of its solution, the publisher must
// rebuild the VDF info, refetch and pack the chunks, assemble, and post bytes identical to
// the node's own binary of that block. The node's signature stands in for signing (its
// key is not ours), so a stub signer returns it; everything else is the real path.
// Fixtures as in test/account-tree.test.mjs.
// Run: node test/block-publisher.test.mjs [fixtures directory]   (default: ./localnet_fixtures)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { Bytes } from '../src/core/bytes.js';
import { FixtureAccountTree } from './fixture-account-tree.mjs';
import { RewardHistory } from '../src/blocks/rewards.js';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { ChainState } from '../src/blocks/assembler.js';
import { ChainFollower } from '../src/blocks/chain-follower.js';
import { BlockHash } from '../src/blocks/hash.js';
import { BlockPublisher } from '../src/blocks/block-publisher.js';
import { BlockBinary } from '../src/blocks/binary.js';
import { NetworkRules } from '../src/blocks/network-rules.js';
import { RecordedVdfSteps } from '../src/blocks/vdf-info.js';
import { TestCase } from './test-case.mjs';
import { StoredRandomx } from './file-result-store.mjs';

class BlockPublisherTest extends TestCase {
  constructor(fixturesDirectory) {
    super();
    this.fixturesDirectory = fixturesDirectory;
  }


  async firstState(files) {
    const { parent } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${files.find((name) => name.startsWith('block_'))}`, 'utf8'));
    const walletFile = `${this.fixturesDirectory}/${files.find((name) => name.startsWith('wallet_list_'))}`;
    const { tree: accountTree } = await FixtureAccountTree.load(walletFile, parent.block.wallet_list);
    return new ChainState({
      block: parent.block, accountTree, rules: NetworkRules.LOCALNET,
      rewardHistory: RewardHistory.fromBinary(Bytes.fromBase64Url(parent.rewardHistory)),
      blockTimeHistory: BlockTimeHistory.fromBinary(Bytes.fromBase64Url(parent.blockTimeHistory)),
    });
  }

  /** Miner.mineStep's report for the block's own solution. */
  static reportFor(child, parent) {
    const twoChunks = child.recall_byte2 !== undefined && child.recall_byte2 !== null;
    return {
      stepNumber: Number(child.nonce_limiter_info.global_step_number),
      trace: { seed: Bytes.fromBase64Url(parent.nonce_limiter_info.seed).subarray(0, 32) },
      solution: {
        nonce: Number(Bytes.toBigInt(Bytes.fromBase64Url(child.nonce))), hash: Bytes.fromBase64Url(child.hash),
        recallByte1: BigInt(child.recall_byte), ...(twoChunks ? { recallByte2: BigInt(child.recall_byte2) } : {}),
      },
    };
  }

  async run() {
    if (!existsSync(this.fixturesDirectory)) {
      console.log(`SKIP  no localnet fixtures at ${this.fixturesDirectory}`);
      return;
    }
    const { h0Hasher, entropySource } = StoredRandomx.create();
    const files = readdirSync(this.fixturesDirectory).sort();
    const state = await this.firstState(files);
    const follower = new ChainFollower({ state, fetchTransaction: null });

    for (const name of files.filter((file) => file.startsWith('block_'))) {
      const { parent, child, childBinary } = JSON.parse(readFileSync(`${this.fixturesDirectory}/${name}`, 'utf8'));
      const chunks = new Map([[String(BigInt(child.recall_byte) + 1n), child.poa], [String(BigInt(child.recall_byte2 ?? -2) + 1n), child.poa2]]);
      const posted = [];
      const publisher = new BlockPublisher({
        follower, h0Hasher, entropySource,
        fetchChunkJson: async (offset) => {
          const poa = chunks.get(String(offset));
          return { chunk: poa.unpacked_chunk, data_path: poa.data_path, tx_path: poa.tx_path };
        },
        signer: {
          wallet: { addressBytes: Bytes.fromBase64Url(child.reward_addr), address: child.reward_addr, ownerBytes: Bytes.fromBase64Url(child.reward_key) },
          sign: async (block) => {
            const signed = { ...block, signature: child.signature };
            return { ...signed, indep_hash: Bytes.toBase64Url(await BlockHash.indepHash(signed)) };
          },
        },
        nodes: [{ baseUrl: 'test', postBlock: async (binary, id) => { posted.push({ binary, id }); return { status: 200, text: 'OK' }; } }],
      });
      const { block } = await publisher.publish({ report: BlockPublisherTest.reportFor(child, parent.block), stepSource: RecordedVdfSteps.fromBlock(child), timestamp: child.timestamp });
      // The localnet leaves hash_preimage as zeros, so with the node's (zero) preimage put
      // in, our block must be the node's exactly: same id, same bytes.
      const withNodePreimage = { ...block, hash_preimage: child.hash_preimage };
      const id = Bytes.toBase64Url(await BlockHash.indepHash(withNodePreimage));
      const bytesMatch = Buffer.from(BlockBinary.encode({ ...withNodePreimage, indep_hash: id })).equals(Buffer.from(childBinary, 'base64'));
      this.report(`block ${child.height}${child.recall_byte2 ? ' (two chunks)' : ''}: published, and with the node's zero preimage it is the node's block byte for byte`, id === child.indep_hash && bytesMatch && posted.length === 1);
      await follower.apply(child);
    }
    this.finish();
  }
}

await new BlockPublisherTest(process.argv[2] ?? 'localnet_fixtures').run();
