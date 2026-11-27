// src/blocks/block-publisher.js — from a miner's solution to a block posted to nodes: the VDF info
// since the parent, the solution's proofs (its chunks fetched again, unpacked, and its
// sub-chunks packed), the whole block on the followed chain state, a guarded signature, and
// POST /block2 to every node given. Each stage checks the last, so a mismatch stops the
// block before it is signed rather than posting something nodes would reject.
import { Bytes } from '../core/bytes.js';
import { Difficulty } from '../mining/difficulty.js';
import { BlockAssembler } from './assembler.js';
import { BlockBinary } from './binary.js';
import { BlockSolution } from './solution.js';
import { VdfInfo } from './vdf-info.js';

export class BlockPublishError extends Error {
  /** Why a solution did not become a posted block, and at which stage. */
  constructor(stage, message) {
    super(`${stage}: ${message}`);
    this.stage = stage;
  }
}

export class BlockPublisher {
  /**
   * `follower` is a ChainFollower kept on the tip; `signer` a BlockSigner (with its
   * double-signing guard); `fetchChunkJson(byte)` resolves GET /chunk for the chunk holding
   * a 1-based weave offset, unpacked; `nodes` are NodeClients to post to. `h0Hasher` and
   * `entropySource` are real RandomX (src/mining/randomx.js).
   */
  constructor({ follower, signer, fetchChunkJson, nodes, h0Hasher, entropySource, log = () => {} }) {
    Object.assign(this, { follower, signer, fetchChunkJson, nodes, h0Hasher, entropySource, log });
  }

  /**
   * Turns `report` (Miner.mineStep's, with a solution) into a block and posts it. `stepSource`
   * supplies the VDF steps since the parent (a RecordedVdfSteps over a VdfStepRecord);
   * `transactions` (JSON, in block order) are carried, none by default.
   * Resolves { block, replies: [{ node, status, text }] }; throws BlockPublishError.
   */
  async publish({ report, stepSource, timestamp = Math.floor(Date.now() / 1000), transactions = [] }) {
    const state = this.follower.state;
    const parent = state.block;
    const { solution } = report;
    const parentStep = Number(parent.nonce_limiter_info.global_step_number);
    if (report.stepNumber <= parentStep) throw new BlockPublishError('VDF', `the solution's step ${report.stepNumber} is not after the tip's step ${parentStep} (block ${parent.height}); a newer block came first`);

    const vdfInfo = await VdfInfo.afterParent({ parent, parentBlockTimeHistory: state.blockTimeHistory, stepNumber: report.stepNumber, stepSource })
      .catch((error) => { throw new BlockPublishError('VDF', error.message); });
    // H0 takes the parent's seed (ar_block:compute_h0), even when the block's own VDF info
    // has moved to a new seed past a reset line.
    const seed = Bytes.fromBase64Url(parent.nonce_limiter_info.seed);
    if (Bytes.toBase64Url(seed.subarray(0, 32)) !== Bytes.toBase64Url(report.trace.seed)) {
      throw new BlockPublishError('VDF', 'the solution was mined with another seed than the tip block\'s; a new block arrived while mining');
    }

    const chunkFor = async (recallByte) => this.fetchChunkJson(recallByte + 1n).catch((error) => { throw new BlockPublishError('chunk', `the chunk at ${recallByte} could not be fetched again: ${error.message}`); });
    const twoChunks = solution.recallByte2 !== undefined;
    const fields = await BlockSolution.build({
      addressBytes: this.signer.key.addressBytes, vdfInfo, seed, nonce: solution.nonce,
      recallByte: solution.recallByte1, chunkJson: await chunkFor(solution.recallByte1),
      ...(twoChunks ? { recallByte2: solution.recallByte2, chunk2Json: await chunkFor(solution.recallByte2) } : {}),
      h0Hasher: this.h0Hasher, entropySource: this.entropySource,
    });
    if (fields.hash !== Bytes.toBase64Url(solution.hash)) throw new BlockPublishError('solution', 'rebuilding the solution from the fetched chunks gave a different hash than the miner found');

    const block = await BlockAssembler.assemble({ state, solution: fields, rewardAddress: this.signer.key.address, rewardKey: Bytes.toBase64Url(this.signer.key.ownerBytes), timestamp: Math.max(timestamp, Number(parent.timestamp)), transactions });
    // At a retarget height the block's own difficulty can be higher than the one mined against.
    if (state.rules.difficultyChecked && !Difficulty.passes(solution.hash, !twoChunks, BigInt(block.diff))) throw new BlockPublishError('difficulty', `the solution does not pass block ${block.height}'s difficulty`);

    const signed = await this.signer.sign(block).catch((error) => { throw new BlockPublishError('signing', error.message); });
    const binary = BlockBinary.encode(signed);
    this.log(`posting block ${signed.height} (${signed.indep_hash.slice(0, 12)}…) to ${this.nodes.length} nodes`);
    const replies = await Promise.all(this.nodes.map(async (node) => {
      try {
        return { node: node.baseUrl, ...(await node.postBlock(binary)) };
      } catch (error) {
        return { node: node.baseUrl, status: 0, text: error.cause?.message ?? error.message };
      }
    }));
    return { block: signed, replies };
  }
}
