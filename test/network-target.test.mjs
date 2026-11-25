// test/network-target.test.mjs — NetworkTarget: the page address picks the network, a
// localnet's rules let a miner aim at held data and pass every hash, and a localnet's
// chunks are fetched in order from its seeded start. Run: node test/network-target.test.mjs
import { NetworkTarget } from '../src/network/network-target.js';
import { Miner } from '../src/mining/miner.js';

class NetworkTargetTest {
  run() {
    const mainnet = NetworkTarget.fromPageAddress('file:///tmp/weave-tab-miner.html');
    const localnet = NetworkTarget.fromPageAddress('file:///tmp/weave-tab-miner.html?localnet=http://127.0.0.1:1985/');
    const positions = [...localnet.chunkPositions(0n, ['unused'][Symbol.iterator](), 262144)];
    const miner = new Miner({ identity: null, partitionNumber: 0, storage: null, h0Hasher: null, testMode: localnet.rules.minerAllowance() });
    const checks = [
      ['a plain address is the mainnet, with its checks and no fixed node', mainnet.isMainnet && mainnet.nodeUrls === null && mainnet.rules.minerAllowance().difficultyEase === 1],
      ['?localnet= names the localnet node, without a trailing slash', !localnet.isMainnet && localnet.nodeUrls.join() === 'http://127.0.0.1:1985' && localnet.stepsComputedHere],
      ['a localnet\'s rules aim range 1 at held data and pass every hash', localnet.rules.minerAllowance().aimRange1AtHeldData && miner.easedPasses(new Uint8Array(48), true, (1n << 256n) - 1n)],
      ['a localnet\'s chunks are fetched in order through its seeded bytes', positions.length === 84 && positions[1] === 262144n],
      ['the mainnet fetches the positions it is given', [...mainnet.chunkPositions(0n, [5n, 9n][Symbol.iterator](), 262144)].join() === '5,9'],
    ];
    let failures = 0;
    for (const [name, passed] of checks) {
      if (!passed) failures++;
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
    }
    process.exitCode = failures ? 1 : 0;
  }
}

new NetworkTargetTest().run();
