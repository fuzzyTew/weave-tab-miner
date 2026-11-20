// src/core/denomination.js — Arweave's denominations: a redenomination makes the unit 1,000 times
// smaller (ar_pricing.erl), so amounts written in an older denomination are scaled up.

export class Denomination {
  /**
   * ar_pricing:redenominate: `amount` (BigInt) written in `fromDenomination`, in
   * `toDenomination`. Denomination 0 marks amounts from before denominations existed,
   * which are taken as they are.
   */
  static redenominate(amount, fromDenomination, toDenomination) {
    if (fromDenomination === 0 || toDenomination <= fromDenomination) return amount;
    return amount * 1000n ** BigInt(toDenomination - fromDenomination);
  }
}
