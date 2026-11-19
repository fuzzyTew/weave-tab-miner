// src/core/pretty-number.js — Number and byte-count formatting for people.
// Part of the library split from the original src/mining/; see README.md "Layout".

export class PrettyNumber {
  /**
   * Short readable multipliers and durations for status text.
   */
  static factor(value) {
    if (!isFinite(value)) return '∞';
    return value < 10 ? value.toPrecision(2) : value < 1e6 ? Math.round(value).toLocaleString() : value.toExponential(1).replace('e+', ' × 10^');
  }

  static bytes(count) {
    const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (count >= 1024 && unit < units.length - 1) { count /= 1024; unit++; }
    return `${count.toPrecision(3)} ${units[unit]}`;
  }

  static times(value) {
    if (!isFinite(value)) return 'infinitely';
    return value < 1e6 ? `${Math.round(value).toLocaleString()}×` : `${value.toExponential(1).replace('e+', ' × 10^')}×`;
  }
}
