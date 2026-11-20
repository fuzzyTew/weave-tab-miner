// test/erlang-term.test.mjs — ErlangTerm on a /wallet_list page built by hand to the external term
// format (term_to_binary of #{next_cursor => last, wallets => [...]}), with both account
// layouts and a bignum balance, read through NodeClient.walletJson. The localnet
// workflow's post mode reads real pages the same way.
// Run: node test/erlang-term.test.mjs
import { ErlangTerm } from '../src/network/erlang-term.js';
import { NodeClient } from '../src/network/node-client.js';

class ErlangTermTest {
  static atom(name) {
    return [119, name.length, ...new TextEncoder().encode(name)];
  }

  static binary(bytes) {
    return [109, 0, 0, 0, bytes.length, ...bytes];
  }

  /** SMALL_BIG_EXT: little-endian digits. */
  static big(value) {
    const digits = [];
    for (let rest = value; rest > 0n; rest >>= 8n) digits.push(Number(rest & 0xffn));
    return [110, digits.length, 0, ...digits];
  }

  run() {
    const address1 = new Array(32).fill(1);
    const address2 = new Array(32).fill(2);
    const bytes = new Uint8Array([
      131, 116, 0, 0, 0, 2,
      ...ErlangTermTest.atom('next_cursor'), ...ErlangTermTest.atom('last'),
      ...ErlangTermTest.atom('wallets'), 108, 0, 0, 0, 2,
      104, 2, ...ErlangTermTest.binary(address1), 104, 2, ...ErlangTermTest.big(123_456_789_012_345n), ...ErlangTermTest.binary([7, 7]),
      104, 2, ...ErlangTermTest.binary(address2), 104, 4, 97, 5, ...ErlangTermTest.binary([]), 97, 1, ...ErlangTermTest.atom('false'),
      106,
    ]);
    const page = ErlangTerm.decode(bytes);
    const wallets = page.get('wallets').map(NodeClient.walletJson);
    const checks = [
      ['the last page says so with the atom last', page.get('next_cursor').name === 'last'],
      ['a short-form account: address, bignum balance, last transaction', wallets[0].balance === '123456789012345' && wallets[0].last_tx === 'Bwc' && wallets[0].denomination === undefined],
      ['a long-form account: denomination and mining permission', wallets[1].balance === '5' && wallets[1].denomination === 1 && wallets[1].mining_permission === false],
    ];
    let failures = 0;
    for (const [name, passed] of checks) {
      if (!passed) failures++;
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
    }
    process.exitCode = failures ? 1 : 0;
  }
}

new ErlangTermTest().run();
