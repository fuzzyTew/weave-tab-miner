// src/blocks/block-transactions.js — what a block's transactions add to it: the weave grows by
// each one's data (padded to whole chunks), tx_root commits to their data roots and where
// each ends, and their fees are split between the miner and the endowment pool. Rules from
// ar_block:generate_size_tagged_list_from_txs and generate_tx_root_for_block,
// ar_tx:get_weave_size_increase, and ar_pricing:distribute_transaction_fees2.
import { Bytes } from '../core/bytes.js';
import { ConsensusConstants } from '../core/constants.js';
import { Denomination } from '../core/denomination.js';
import { Secp256k1 } from '../core/secp256k1.js';
import { Sha256 } from '../core/sha256.js';
import { DataMerkle, DeepHash } from '../wallet/transaction.js';

export class BlockTransactions {
  /**
   * The miner's share of each fee; the endowment pool gets the rest. From the end of the
   * 2.7.2 price transition (v2 pricing), ?MINER_FEE_SHARE: 1/21. Before it, the 2.5 rule
   * (ar_pricing:distribute_transaction_fees with ?MINING_REWARD_MULTIPLIER {2, 10}): 2/12.
   * Found by rebuilding mainnet block 2,047,038, whose four fees were split 1/6.
   */
  static MINER_FEE_SHARE = [1n, 21n];
  static PRE_V2_MINER_FEE_SHARE = [2n, 12n];
  static V2_PRICING_HEIGHT = 2_069_870;

  /** The weave grows by a transaction's data, padded up to a whole number of chunks. */
  static weaveSizeIncrease(dataSize) {
    const size = BigInt(dataSize);
    const chunk = BigInt(ConsensusConstants.DATA_CHUNK_SIZE);
    return size === 0n ? 0n : ((size + chunk - 1n) / chunk) * chunk;
  }

  /**
   * A transaction's data root: format 2 names it; format 1 carries its data inline, whose
   * chunk tree is built here.
   */
  static dataRoot(json) {
    if (Number(json.format) === 2) return Bytes.fromBase64Url(json.data_root ?? '');
    return DataMerkle.root(Bytes.fromBase64Url(json.data ?? ''));
  }

  /**
   * Transactions in the order their data is laid out in the weave: generate_size_tagged_
   * list_from_txs sorts the tx records (lists:sort), which compares their fields in record
   * order — format first, then id bytes — whatever order the block lists them in. Found by
   * rebuilding mainnet block 2,047,060's tx_root.
   */
  static inWeaveOrder(transactions) {
    const compareBytes = (left, right) => {
      for (let index = 0; index < Math.min(left.length, right.length); index++) if (left[index] !== right[index]) return left[index] - right[index];
      return left.length - right.length;
    };
    return transactions.slice().sort((left, right) => (Number(left.format) - Number(right.format)) || compareBytes(Bytes.fromBase64Url(left.id), Bytes.fromBase64Url(right.id)));
  }

  /**
   * The leaves tx_root is built from, in weave order (inWeaveOrder): each transaction's data
   * root at its end offset in the block, then, when its data does not fill its last chunk,
   * a padding leaf (empty data root) at the padded end.
   */
  static sizeTaggedLeaves(transactions) {
    const leaves = [];
    let position = 0n;
    for (const json of BlockTransactions.inWeaveOrder(transactions)) {
      const dataSize = BigInt(json.data_size || 0);
      const end = position + dataSize;
      leaves.push({ dataHash: BlockTransactions.dataRoot(json), endOffset: end });
      const paddedEnd = position + BlockTransactions.weaveSizeIncrease(dataSize);
      if (paddedEnd > end) leaves.push({ dataHash: new Uint8Array(0), endOffset: paddedEnd });
      position = paddedEnd;
    }
    return leaves;
  }

  /**
   * The fields transactions set on a block over `parent`: txs (ids), block_size, weave_size
   * and tx_root, in block JSON's form.
   */
  static fields(transactions, parent) {
    const blockSize = transactions.reduce((total, json) => total + BlockTransactions.weaveSizeIncrease(json.data_size || 0), 0n);
    return {
      txs: transactions.map((json) => json.id),
      block_size: blockSize.toString(),
      weave_size: (BigInt(parent.weave_size) + blockSize).toString(),
      tx_root: transactions.length ? Bytes.toBase64Url(DataMerkle.rootOfLeaves(BlockTransactions.sizeTaggedLeaves(transactions))) : '',
    };
  }

  /** { minerShare, endowmentShare } of the fees in a block at `height`, in `denomination` (BigInt). */
  static feeShares(transactions, denomination, height) {
    const [dividend, divisor] = height >= BlockTransactions.V2_PRICING_HEIGHT ? BlockTransactions.MINER_FEE_SHARE : BlockTransactions.PRE_V2_MINER_FEE_SHARE;
    let minerShare = 0n;
    let endowmentShare = 0n;
    for (const json of transactions) {
      const fee = Denomination.redenominate(BigInt(json.reward || 0), Number(json.denomination ?? 0), denomination);
      const minerFee = fee * dividend / divisor;
      minerShare += minerFee;
      endowmentShare += fee - minerFee;
    }
    return { minerShare, endowmentShare };
  }

  /**
   * The data a secp256k1-signed transaction's signature covers
   * (ar_tx:signature_data_segment_v2_no_public_key): the format-2 fields without the owner,
   * deep-hashed, with the denomination first when there is one.
   */
  static async secp256k1SignedData(json) {
    const text = (value) => new TextEncoder().encode(String(value));
    const fields = [
      text(json.format), Bytes.fromBase64Url(json.target ?? ''), text(json.quantity || 0), text(json.reward || 0),
      Bytes.fromBase64Url(json.last_tx ?? ''), (json.tags ?? []).map((tag) => [Bytes.fromBase64Url(tag.name), Bytes.fromBase64Url(tag.value)]),
      text(json.data_size || 0), Bytes.fromBase64Url(json.data_root ?? ''),
    ];
    if (Number(json.denomination ?? 0) > 0) fields.unshift(text(json.denomination));
    return DeepHash.of(fields);
  }

  /**
   * A transaction's account-changing fields (AccountTree.applyTransaction's) from its JSON (ar_serialize:json_struct_to_tx):
   * amounts as BigInt; `denomination` absent means 0 (taken as it is). The sender's address
   * is SHA-256 of its public key (ar_wallet:to_address); secp256k1-signed transactions
   * leave the owner empty, so their key is recovered from the signature, as nodes do.
   */
  static async accountChange(json) {
    let ownerBytes = Bytes.fromBase64Url(json.owner ?? '');
    if (!ownerBytes.length) {
      if (Number(json.format) !== 2) throw new Error(`transaction ${json.id} has no owner key and is not format 2`);
      ownerBytes = Secp256k1.recoverPublicKey(await BlockTransactions.secp256k1SignedData(json), Bytes.fromBase64Url(json.signature));
    }
    return {
      idBytes: Bytes.fromBase64Url(json.id),
      ownerAddressBytes: Sha256.hash(ownerBytes),
      targetBytes: Bytes.fromBase64Url(json.target ?? ''),
      quantity: BigInt(json.quantity || 0),
      reward: BigInt(json.reward || 0),
      denomination: Number(json.denomination ?? 0),
    };
  }

  /**
   * A block's account changes in the node's order (ar_node_utils:update_accounts): its
   * transactions (JSON, in block order), then the released reward
   * (RewardHistory.releasedReward), in the parent's `denomination`.
   */
  static async applyToAccounts(accountTree, transactions, released, denomination) {
    for (const json of transactions) accountTree.applyTransaction(await BlockTransactions.accountChange(json), denomination);
    accountTree.applyReward(released.addressBytes, released.reward, denomination);
  }
}
