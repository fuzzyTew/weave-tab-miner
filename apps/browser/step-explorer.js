// apps/browser/step-explorer.js — The step explorer (one mined step traced to the node source) and the measured VDF pace.
import { Bytes } from '../../src/core/bytes.js';
import { ConsensusConstants } from '../../src/core/constants.js';
import { SourceCitations } from '../../src/core/citations.js';

export class StepExplorer {
  /**
   * Shows one mining step's intermediate values, each with a link to the node source rule
   * that produces it, so a person can redo the step by hand.
   */
  constructor(view) {
    this.view = view;
  }

  static row(label, value, ruleName) {
    const row = document.createElement('tr');
    const labelCell = document.createElement('th');
    labelCell.scope = 'row';
    labelCell.textContent = label;
    const valueCell = document.createElement('td');
    valueCell.className = 'explorer-value';
    valueCell.textContent = value;
    const sourceCell = document.createElement('td');
    if (ruleName) {
      const link = document.createElement('a');
      link.href = SourceCitations.url(ruleName);
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = SourceCitations.label(ruleName);
      link.title = SourceCitations.RULES[ruleName].what;
      sourceCell.append(link);
    }
    row.append(labelCell, valueCell, sourceCell);
    return row;
  }

  show(report) {
    const trace = report.trace;
    const hex = (bytes) => Bytes.toHex(bytes);
    const rows = [
      ['VDF output, step ' + report.stepNumber.toLocaleString(), hex(trace.vdfOutput), 'vdfStep'],
      ['Partition number', String(trace.partitionNumber), 'h0'],
      ['Seed (first 32 bytes)', hex(trace.seed), 'h0Seed'],
      ['Mining address', hex(trace.address), 'h0'],
      ['Packing difficulty', String(trace.packingDifficulty), 'h0'],
      ['H0 preimage', hex(trace.h0Preimage), 'h0'],
      [trace.h0IsStub ? 'H0 (SHA-256 stand-in)' : 'H0 = RandomX(preimage)', hex(trace.h0), trace.h0IsStub ? null : 'h0RandomxState'],
      ['Recall range 1 start', trace.range1Start.toLocaleString(), 'recallRange'],
      ['Recall range 2 start', trace.range2Start.toLocaleString(), 'recallRange'],
      ['Nonces per range', `${ConsensusConstants.noncesPerRecallRange} (${ConsensusConstants.recallRangeSize.toLocaleString()} bytes ÷ 8 KiB)`, 'recallRangeSize'],
    ];
    const tried = trace.firstHeldNonce;
    if (tried) {
      rows.push(
        ['First nonce on held data', String(tried.nonce), 'recallByte'],
        ['→ recall byte 1, sub-chunk', `${tried.recallByte1.toLocaleString()}, sub-chunk ${tried.subChunkIndex}`, 'recallByte'],
        ['H1 preimage', hex(tried.h1.preimage), 'h1'],
        ['H1', hex(tried.h1.hash), 'h1'],
        ['→ recall byte 2', `${tried.recallByte2.toLocaleString()}${tried.h2 ? '' : ' (not held, so no H2)'}`, 'recallByte'],
      );
      if (tried.h2) rows.push(['H2 preimage', hex(tried.h2.preimage), 'h2'], ['H2', hex(tried.h2.hash), 'solutionHash']);
    } else {
      rows.push(['Nonces on held data', 'none this step: neither recall range touched a held chunk', 'recallRange']);
    }
    rows.push(['Pass rule', 'hash, as a big-endian number, must exceed the scaled difficulty', 'diffCheck']);
    if (report.solution) rows.push(['Result', `${report.solution.kind} at nonce ${report.solution.nonce}: ${hex(report.solution.hash)}`, 'diffCheck']);

    const body = this.view.elements.explorerRows;
    body.replaceChildren(...rows.map(([label, value, rule]) => StepExplorer.row(label, value, rule)));
    this.view.setText('explorerTitle', `Step ${report.stepNumber.toLocaleString()}`);
  }
}
