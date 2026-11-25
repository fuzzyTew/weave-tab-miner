// test/test-case.mjs — what every test class shares: counting failures, one PASS or FAIL
// line per check, and the exit code at the end.

export class TestCase {
  constructor() {
    this.failures = 0;
  }

  /** Prints one check's result, with an optional detail after a dash. */
  report(name, passed, detail = '') {
    if (!passed) this.failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  /** Sets the process's exit code from the failures counted. */
  finish() {
    process.exitCode = this.failures ? 1 : 0;
  }
}
