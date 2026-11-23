// src/blocks/transaction-picker.js — choosing pending transactions for a block we mine, keeping
// only those certain to be valid: one invalid transaction makes the whole block invalid and
// wastes a real solution. The checks are a node's (ar_tx:do_verify_v2 and
// ar_tx_replay_pool:verify_block_txs), applied in order with each picked transaction's
// account changes, so later ones see earlier ones' effects.
//
// Left to the nodes the transactions came from: signatures. A node's mempool holds only
// transactions whose signatures it checked; here the id must still be SHA-256 of the
// signature, so a header changed on the way does not pass.
import { Bytes } from '../core/bytes.js';
import { Sha256 } from '../core/sha256.js';
import { BlockTransactions } from './block-transactions.js';

export class TransactionPicker {
  /** ?BLOCK_TX_COUNT_LIMIT. */
  static MAX_TRANSACTIONS = 1000;
  /** ?TX_SIZE_BASE: bytes added to every transaction's size for its fee. */
  static TX_SIZE_BASE = 3210n;
  /** ?NEW_ACCOUNT_FEE_DATA_SIZE_EQUIVALENT: a new target account costs as much as this many bytes. */
  static NEW_ACCOUNT_FEE_BYTES = 20_000_000n;
  /** ?LN_PRICE_DECAY_ANNUAL and ?MINER_MINIMUM_ENDOWMENT_CONTRIBUTION_SHARE. */
  static LN_PRICE_DECAY_ANNUAL = [-5012541823544286n, 1000000000000000000n];
  static MINER_MINIMUM_SHARE = [1n, 20n];
  static N_REPLICATIONS = 20n;
  static GIB = 1n << 30n;

  /**
   * The least fee for `bytes` of size (ar_pricing:get_tx_fee): storing it for ever at the
   * parent's price per GiB-minute, decaying as storage gets cheaper, times the replica
   * count and the Kryder+ multiplier, plus a twentieth for the miner.
   */
  static feeForBytes(bytes, pricePerGibMinute, kryderMultiplier) {
    const firstYearPrice = bytes * pricePerGibMinute * 60n * 24n * 365n;
    const [lnDividend, lnDivisor] = TransactionPicker.LN_PRICE_DECAY_ANNUAL;
    const numerator = -firstYearPrice * lnDivisor * kryderMultiplier * TransactionPicker.N_REPLICATIONS;
    const denominator = lnDividend * TransactionPicker.GIB;
    // ar_fraction:add of the price and its twentieth: (n/d)·(21/20), as one fraction.
    const [shareDividend, shareDivisor] = TransactionPicker.MINER_MINIMUM_SHARE;
    return (numerator * denominator * (shareDivisor + shareDividend)) / (denominator * denominator * shareDivisor);
  }

  /** The least fee for a transaction (ar_tx:get_tx_fee2), given whether its target exists. */
  static minimumFee(json, { pricePerGibMinute, kryderMultiplier, targetExists }) {
    const size = BlockTransactions.weaveSizeIncrease(json.data_size || 0) + TransactionPicker.TX_SIZE_BASE;
    const uploadFee = TransactionPicker.feeForBytes(size, pricePerGibMinute, kryderMultiplier);
    return targetExists ? uploadFee : uploadFee + TransactionPicker.feeForBytes(TransactionPicker.NEW_ACCOUNT_FEE_BYTES, pricePerGibMinute, kryderMultiplier);
  }

  /**
   * Why a transaction cannot go in, judged on its own (before account checks), or null.
   * `denomination` is the parent's.
   */
  static fieldProblem(json, denomination) {
    if (Number(json.format) !== 2) return 'not format 2 (format 1 is no longer accepted)';
    const txDenomination = Number(json.denomination ?? 0);
    if (txDenomination !== 0 && txDenomination !== denomination) return `denomination ${txDenomination}, not the block's ${denomination}`;
    const signature = Bytes.fromBase64Url(json.signature ?? '');
    if (!signature.length || Bytes.toBase64Url(Sha256.hash(signature)) !== json.id) return 'its id is not the hash of its signature';
    const target = Bytes.fromBase64Url(json.target ?? '');
    const quantity = BigInt(json.quantity || 0);
    if (quantity < 0n) return 'negative quantity';
    if (!(target.length === 32 || (target.length === 0 && quantity === 0n))) return 'a target that is not 32 bytes';
    const dataSize = BigInt(json.data_size || 0);
    if ((dataSize === 0n) !== (Bytes.fromBase64Url(json.data_root ?? '').length === 0)) return 'data size and data root disagree';
    const maxDigits = 30 + (denomination - 1) * 3;
    if (String(quantity).length > maxDigits || String(json.reward || 0).length > maxDigits || String(dataSize).length > 21) return 'a number too long';
    if (Bytes.fromBase64Url(json.last_tx ?? '').length > 48 || Bytes.fromBase64Url(json.owner ?? '').length > 512 || signature.length > 512) return 'a field too long';
    const tagBytes = (json.tags ?? []).reduce((total, tag) => total + Bytes.fromBase64Url(tag.name).length + Bytes.fromBase64Url(tag.value).length, 0);
    if (tagBytes > 2048) return 'tags over 2048 bytes';
    return null;
  }

  /**
   * Picks from `candidates` (transaction JSON, as pending at a node) for a block on
   * `state` (a ChainState). Resolves { picked, rejected: [{ id, reason }] }. The account
   * tree is left as it was.
   *
   * `state.recentBlocks` may hold fewer than the last 50 blocks (newest first, unbroken),
   * as a page that has just read the chain state does. That stays safe: only those blocks
   * are taken as anchors, and a transaction anchored to one could only have been mined in
   * it or a later one, all of which are checked for repeats. A transaction anchored to its
   * sender's last transaction cannot repeat, since mining it changes that last transaction.
   */
  static async pick(candidates, state, { limit = TransactionPicker.MAX_TRANSACTIONS } = {}) {
    const parent = state.block;
    const denomination = Number(parent.denomination);
    const pricing = { pricePerGibMinute: BigInt(parent.price_per_gib_minute), kryderMultiplier: BigInt(parent.kryder_plus_rate_multiplier) };
    const anchors = new Set(state.recentBlocks.map((block) => block.indepHash));
    const recentIds = new Set(state.recentBlocks.flatMap((block) => block.txIds));
    const picked = [];
    const rejected = [];
    const pickedIds = new Set();
    await state.accountTree.withUndoneChanges(async (tree) => {
      for (const json of candidates) {
        if (picked.length >= limit) break;
        const reason = await TransactionPicker.problem(json, { tree, denomination, pricing, anchors, recentIds, pickedIds });
        if (reason) {
          rejected.push({ id: json.id, reason });
          continue;
        }
        tree.applyTransaction(await BlockTransactions.accountChange(json), denomination);
        picked.push(json);
        pickedIds.add(json.id);
      }
    });
    return { picked, rejected };
  }

  /** Why `json` cannot follow the transactions picked so far (whose changes `tree` holds), or null. */
  static async problem(json, { tree, denomination, pricing, anchors, recentIds, pickedIds }) {
    const fieldProblem = TransactionPicker.fieldProblem(json, denomination);
    if (fieldProblem) return fieldProblem;
    if (pickedIds.has(json.id) || recentIds.has(json.id)) return 'already in a recent block or this one';
    if (pickedIds.has(json.last_tx)) return 'anchored to a transaction in this block';
    let change;
    try {
      change = await BlockTransactions.accountChange(json);
    } catch (error) {
      return error.message;
    }
    const sender = tree.get(change.ownerAddressBytes);
    if (!sender) return 'the sender has no account';
    // Anchor: the sender's last transaction, or one of the last 50 blocks.
    if (json.last_tx !== Bytes.toBase64Url(sender.lastTx) && !anchors.has(json.last_tx)) return 'its anchor is neither the sender\'s last transaction nor a recent block';
    if (change.targetBytes.length && Bytes.toBase64Url(change.targetBytes) === Bytes.toBase64Url(change.ownerAddressBytes)) return 'sent to its own sender';
    const targetExists = !change.targetBytes.length || Boolean(tree.get(change.targetBytes));
    const fee = BigInt(json.reward || 0);
    const minimum = TransactionPicker.minimumFee(json, { ...pricing, targetExists });
    if (fee < minimum) return `fee ${fee} under the least ${minimum}`;
    // Overspend: after it, the sender (and a target) must exist with a balance of at least 0.
    const spent = change.quantity + change.reward;
    if (tree.constructor.balanceIn(sender, denomination) < spent) return 'the sender cannot pay it';
    if (change.targetBytes.length && change.quantity === 0n) {
      const target = tree.get(change.targetBytes);
      if (!target || (target.balance === 0n && target.lastTx.length === 0)) return 'a target with no account, and nothing sent to make one';
    }
    return null;
  }
}
