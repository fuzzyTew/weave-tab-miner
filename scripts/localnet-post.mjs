// scripts/localnet-post.mjs — mines blocks with this library and posts them to a running
// Arweave localnet, several in a row, and reports what the node accepted. Step 6 of
// docs/TODO.md "Turn a solution into a block". Run by the localnet workflow:
//   node scripts/localnet-post.mjs <blocks to post> [VDF steps ahead: same | computed]
//
// A localnet skips the difficulty check and lets a block name its recall chunk, so every
// attempt can be a block: the script picks a chunk from the localnet's seeded data, packs
// its proven sub-chunk for a fresh RSA key, and builds the block either on the tip's own
// VDF step ("same", which only a localnet allows) or, by default, 1 or 2 steps after it
// with the steps computed here, as on mainnet ("computed", about 8 s a step). Everything
// else is checked by the node as on mainnet.
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { createHash, randomInt } from 'node:crypto';
import { LocalnetClient } from './localnet-client.mjs';
import { Bytes } from '../src/core/bytes.js';
import { ConsensusConstants } from '../src/core/constants.js';
import { AccountTree } from '../src/blocks/account-tree.js';
import { RewardHistory } from '../src/blocks/rewards.js';
import { BlockTimeHistory } from '../src/blocks/history.js';
import { BlockAssembler, ChainState } from '../src/blocks/assembler.js';
import { BlockSolution } from '../src/blocks/solution.js';
import { ComputedVdfSteps, VdfInfo } from '../src/blocks/vdf-info.js';
import { BlockSigner } from '../src/blocks/signer.js';
import { DoubleSigningGuard } from '../src/blocks/signing-guard.js';
import { BlockBinary } from '../src/blocks/binary.js';
import { ChainFollower } from '../src/blocks/chain-follower.js';
import { NetworkRules } from '../src/blocks/network-rules.js';
import { ArweaveWallet } from '../src/wallet/wallet.js';
import { RandomxDirectHost, RandomxH0Hasher, RandomxSquaredEntropySource } from '../src/mining/randomx.js';

class MapStorage {
  /** The getItem/setItem part of localStorage, in memory: the guard's records for this run. */
  constructor() { this.items = new Map(); }
  getItem(key) { return this.items.get(key) ?? null; }
  setItem(key, value) { this.items.set(key, value); }
}

class LocalnetBlockPoster {
  // The localnet seeds about 21 MiB of data near the start of the weave, with gaps (the
  // node answers 404 there), so chunks are drawn from the first 20 MiB until one is held.
  static SEEDED_BYTES = 20 * 1024 * 1024;
  static CHUNK_DRAWS = 40;
  static ACCEPT_TIMEOUT_MS = 120000;

  constructor({ blockCount, vdfMode = 'computed', client = new LocalnetClient() }) {
    Object.assign(this, { blockCount, vdfMode, client });
    this.vdfSteps = new ComputedVdfSteps();
  }

  /** The VDF info of block `index` of this run: alternately 1 and 2 steps ahead, unless "same". */
  async vdfInfo(state, index) {
    if (this.vdfMode === 'same') return VdfInfo.sameStepAsParent(state.block);
    return VdfInfo.afterParent({
      parent: state.block, parentBlockTimeHistory: state.blockTimeHistory,
      stepNumber: Number(state.block.nonce_limiter_info.global_step_number) + 1 + (index % 2), stepSource: this.vdfSteps,
    });
  }

  /** The tip with its reward and block-time histories, waiting up to ACCEPT_TIMEOUT_MS for them. */
  async tipWithHistories() {
    const started = Date.now();
    for (;;) {
      const tip = await this.client.get(`/block/height/${await this.client.height()}`);
      try {
        return {
          tip,
          rewardHistory: await this.client.get(`/reward_history/${tip.indep_hash}`, 'bytes'),
          blockTimeHistory: await this.client.get(`/block_time_history/${tip.indep_hash}`, 'bytes'),
        };
      } catch (error) {
        if (Date.now() - started > LocalnetBlockPoster.ACCEPT_TIMEOUT_MS) throw new Error(`no histories for tip ${tip.height}`, { cause: error });
        console.log(`tip ${tip.height}: histories not served yet (${error.cause?.message ?? error.message}); waiting`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  async chainState() {
    const { tip, rewardHistory, blockTimeHistory } = await this.tipWithHistories();
    const accounts = await this.client.walletList(tip.wallet_list);
    // Node's SHA-384 is synchronous, which makes hashing the whole account tree much faster.
    const accountTree = new AccountTree({ sha384: (bytes) => new Uint8Array(createHash('sha384').update(bytes).digest()) });
    for (const json of accounts) {
      const { addressBytes, account } = AccountTree.accountFromJson(json);
      accountTree.insert(addressBytes, account);
    }
    const root = Bytes.toBase64Url(await accountTree.rootHash());
    console.log(`tip ${tip.height} (${tip.indep_hash.slice(0, 12)}…): ${accounts.length} accounts, root ${root === tip.wallet_list ? 'matches' : 'DIFFERS from'} the tip's`);
    return new ChainState({
      block: tip,
      rewardHistory: RewardHistory.fromBinary(rewardHistory),
      blockTimeHistory: BlockTimeHistory.fromBinary(blockTimeHistory),
      accountTree,
      rules: NetworkRules.LOCALNET,
    });
  }

  randomx() {
    // The RandomX bundle is a classic script defining RandomxArweave; evaluate it as a page would.
    runInThisContext(readFileSync(new URL('../vendor/randomx-arweave/randomx-arweave.iife.js', import.meta.url), 'utf8') + '\nglobalThis.RandomxArweave = RandomxArweave;');
    const host = new RandomxDirectHost(globalThis.RandomxArweave);
    return { h0Hasher: new RandomxH0Hasher(host), entropySource: new RandomxSquaredEntropySource(host) };
  }

  /** A chunk-aligned recall byte the node holds a chunk at, with that chunk's JSON. */
  async heldChunk() {
    const chunkSize = ConsensusConstants.DATA_CHUNK_SIZE;
    for (let draw = 0; draw < LocalnetBlockPoster.CHUNK_DRAWS; draw++) {
      const recallByte = BigInt(randomInt(LocalnetBlockPoster.SEEDED_BYTES / chunkSize)) * BigInt(chunkSize);
      try {
        return { recallByte, chunkJson: await this.client.get(`/chunk/${recallByte + 1n}`) };
      } catch (error) {
        console.log(`chunk at ${recallByte}: ${error.message}`);
      }
    }
    throw new Error(`no held chunk in ${LocalnetBlockPoster.CHUNK_DRAWS} draws`);
  }

  async waitForTip(indepHash) {
    const started = Date.now();
    while (Date.now() - started < LocalnetBlockPoster.ACCEPT_TIMEOUT_MS) {
      const tip = await this.client.get(`/block/height/${await this.client.height()}`);
      if (tip.indep_hash === indepHash) return true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  }

  async run() {
    const wallet = await ArweaveWallet.generate();
    const signer = new BlockSigner({ wallet, guard: new DoubleSigningGuard({ storage: new MapStorage() }) });
    console.log(`mining as ${wallet.address}`);
    const state = await this.chainState();
    const { h0Hasher, entropySource } = this.randomx();
    let accepted = 0;
    for (let index = 0; index < this.blockCount; index++) {
      const { recallByte, chunkJson } = await this.heldChunk();
      // Every third block is a two-chunk solution (H2), the more common kind on mainnet.
      const second = index % 3 === 2 ? await this.heldChunk() : null;
      const vdfInfo = await this.vdfInfo(state, index);
      const solution = await BlockSolution.build({
        addressBytes: wallet.addressBytes, vdfInfo,
        seed: Bytes.fromBase64Url(vdfInfo.seed), recallByte, chunkJson,
        ...(second ? { recallByte2: second.recallByte, chunk2Json: second.chunkJson } : {}),
        nonce: randomInt(32), h0Hasher, entropySource,
      });
      const timestamp = Math.max(Math.floor(Date.now() / 1000), Number(state.block.timestamp));
      const block = await BlockAssembler.assemble({ state, solution, rewardAddress: wallet.address, rewardKey: Bytes.toBase64Url(wallet.ownerBytes), timestamp });
      const signed = await signer.sign(block);
      const reply = await this.client.postBlock(BlockBinary.encode(signed));
      console.log(`block ${signed.height} (${signed.indep_hash.slice(0, 12)}…, VDF step ${vdfInfo.global_step_number}, chunk at ${recallByte}${second ? ` and ${second.recallByte}` : ''}): POST /block2 → ${reply.status} ${reply.text}`);
      if (!(await this.waitForTip(signed.indep_hash))) {
        console.log(`block ${signed.height} did not become the tip within ${LocalnetBlockPoster.ACCEPT_TIMEOUT_MS / 1000} s; the node log below says why`);
        break;
      }
      accepted++;
      // Retarget and price-adjustment heights are where the fields change; show them.
      const changed = ['diff', 'last_retarget', 'price_per_gib_minute', 'scheduled_price_per_gib_minute'].filter((field) => String(signed[field]) !== String(state.block[field]));
      console.log(`block ${signed.height} accepted: it is the localnet's tip${changed.length ? `; changed: ${changed.map((field) => `${field} ${state.block[field]} → ${signed[field]}`).join(', ')}` : ''}`);
      await new ChainFollower({ state, fetchTransaction: null }).apply(signed);
    }
    console.log(`${accepted} of ${this.blockCount} blocks accepted`);
    process.exitCode = accepted === this.blockCount ? 0 : 1;
  }
}

await new LocalnetBlockPoster({ blockCount: Number(process.argv[2] ?? 3), vdfMode: process.argv[3] ?? 'computed' }).run();
