// apps/browser/page-view.js — The page's elements: reading inputs, showing text, lists and the activity log.
import { Bytes } from '../../src/core/bytes.js';
import { PrettyNumber } from '../../src/core/pretty-number.js';

export class PageView {
  /**
   * Thin helpers over the page's elements, so the controller reads as what it shows.
   */
  constructor() {
    this.elements = new Proxy({}, { get: (_, id) => document.getElementById(id) });
  }

  setText(id, text) {
    this.elements[id].textContent = text;
  }

  log(message, tone = 'info') {
    const line = document.createElement('li');
    line.className = `log-line tone-${tone}`;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    line.textContent = `${time}  ${message}`;
    const list = this.elements.activityLog;
    list.prepend(line);
    while (list.children.length > 200) list.lastChild.remove();
  }

  static shortHex(bytes, length = 12) {
    return Bytes.toHex(bytes).slice(0, length) + '…';
  }

  static formatBytes(count) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let value = count;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  static formatDuration(seconds) {
    if (!isFinite(seconds)) return 'never (no data held)';
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)} minutes`;
    if (seconds < 86_400 * 2) return `${(seconds / 3600).toFixed(1)} hours`;
    const years = seconds / 31_557_600;
    if (years < 1) return `${(seconds / 86_400).toFixed(1)} days`;
    return years < 1e6 ? `${Math.round(years).toLocaleString()} years` : `${years.toExponential(2).replace('e+', ' × 10^')} years`;
  }

  static formatAr(winston) {
    const whole = winston / 1_000_000_000_000n;
    const fraction = (winston % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
    return `${whole}${fraction ? '.' + fraction : ''} AR`;
  }

  addStepRow(report, source, onSelect) {
    const row = document.createElement('tr');
    const result = report.solution ? `found: ${report.solution.kind}` : report.noncesTried ? 'no pass' : 'no data held in range';
    const cells = [
      report.stepNumber.toLocaleString(), source, PageView.shortHex(report.h0, 10),
      report.range1Start.toLocaleString(), report.range2Start.toLocaleString(),
      String(report.noncesTried), String(report.h2Tried), result,
    ];
    for (const text of cells) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    row.tabIndex = 0;
    row.title = 'Show this step in the explorer';
    row.addEventListener('click', onSelect);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter') onSelect(); });
    if (report.solution) row.className = 'row-solution';
    const body = this.elements.stepRows;
    body.prepend(row);
    while (body.children.length > 60) body.lastChild.remove();
  }

  fillHistory(listId, transactions, emptyText) {
    const list = this.elements[listId];
    list.replaceChildren();
    if (transactions.length === 0) {
      const item = document.createElement('li');
      item.textContent = emptyText;
      list.append(item);
      return;
    }
    for (const transaction of transactions) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `https://viewblock.io/arweave/tx/${transaction.id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = transaction.id.slice(0, 12) + '…';
      const height = transaction.block ? `block ${transaction.block.height}` : 'pending';
      const amount = Number(transaction.quantity.ar) > 0 ? `${transaction.quantity.ar} AR` : `${PageView.formatBytes(Number(transaction.data.size))} data`;
      item.append(link, ` · ${amount} · ${height}`);
      list.append(item);
    }
  }

  /** The wait's factors, each as "× N name — why"; ones already at full speed are dimmed. */
  fillLimits(factors) {
    const list = this.elements.limitList;
    list.replaceChildren();
    for (const factor of factors) {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = `× ${PrettyNumber.factor(factor.multiplier)} ${factor.name}`;
      item.append(name, ` — ${factor.explanation}`);
      if (factor.multiplier <= 1.0001) item.className = 'limit-met';
      list.append(item);
    }
  }
}
