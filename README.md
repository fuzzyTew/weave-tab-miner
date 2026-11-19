# Weave Tab Miner

An Arweave (replica 2.9) mining node that runs in a browser tab, or in Node, built
library-first. It uses Arweave's real RandomX, compiled to WebAssembly, for H0 and for
packing, and is checked against mainnet block 2,040,257: replaying that block's VDF steps,
it finds the block's own solution again.

## Use it

Build the page, then open `dist/weave-tab-miner.html` by double-clicking it. No web server or
Python needed.

    npm run build

The page opens on the sample block, mining for the address that won it. **Start mining**
replays the block's last 15 VDF steps and finds its solution. For live mining: load the live
block, pick an identity, fetch and pack chunks, and choose a VDF source.

- **RandomX** needs a 512 MiB cache. If the browser cannot allocate it (a 32-bit browser,
  low memory), the page says so and falls back to SHA-256 stand-ins that find nothing real.
- **Packing** takes about a second per 8 MiB entropy, 32 entropies per batch of chunks.
  Chunks fetched together sit at one position in successive sectors and share those
  entropies. Packed chunks are saved in the browser (IndexedDB) per address.
- **Gateways**: "Find gateways and peers" adds gateways from an ar.io gateway's registry
  (`GET /ar-io/peers`), which also lists Arweave nodes.
- **Peers**: nodes allow browsers (CORS) but speak plain http, which https pages may not
  call. From the downloaded file, **Find peers** tries nodes first, gateways as fallback;
  an https copy says why it uses gateways only.
- **VDF**: a public VDF server keeps the network's pace of a step a second, if one answers.
  Computing steps in the tab is about 20 times slower. (Steps read from the latest block
  are no use: a new block must use steps after the latest block's own step.)
- **What limits the wait** shows the expected time to a solution and what limits it most.
- **Step explorer** shows every value of a mining step, each linked to the line of the
  Arweave node source (commit `18d402c`) that defines it.

## Layout

| Path | What it holds |
|---|---|
| `src/` | The library, with no runtime dependencies; `src/index.js` re-exports it all |
| `src/miner.js` | Constants, SHA-256, VDF, difficulty, packing layout, H0/H1/H2, the miner, odds |
| `src/randomx.js` | Real H0 and packing entropy through `vendor/randomx-arweave` |
| `src/storage.js` | Packed chunks in IndexedDB; export and import files |
| `src/chunk-fetcher.js` | Fetching many chunks at once, with progress and a stop |
| `src/chunk-share.js` | Moving saved chunks between copies of the page |
| `src/signing-guard.js` | Refuses to sign two competing blocks with one key |
| `src/account-tree.js`, `src/rewards.js`, `src/block-history.js`, `src/block-fields.js`, `src/block-hash.js`, `src/block-signer.js` | Block building: the account tree root, released rewards, history hashes, plain fields, the block id, and guarded signing |
| `src/gateway.js`, `src/peers.js` | HTTP to gateways and nodes; finding and testing sources |
| `src/vdf-client.js` | Reading steps from VDF servers (GET /vdf) |
| `src/wallet.js`, `src/transaction.js`, `src/bundle.js` | Keys, signed transactions, ANS-104 items for Turbo |
| `src/citations.js` | Links from each rule to the node source |
| `src/workers/` | The VDF and RandomX web workers |
| `apps/browser/` | The page: `index.html` and its controller `app.js` |
| `apps/node/miner.mjs` | Server mode, same library |
| `scripts/` | The single-file build, source gathering, the live network check, localnet capture |
| `test/` | Tests (`*.test.mjs`), the page check, and `fixtures/` |
| `data/` | Build inputs: the sample block, gathered sources, the page's permaweb id |
| `vendor/randomx-arweave/` | randomx.js built for Arweave, with its patch and build notes |
| `docs/TODO.md` | What is planned |

As a library: `import { Miner, DataItem } from 'weave-tab-miner'`, or one module at a time,
`import { DataItem } from 'weave-tab-miner/bundle'`.

## Server mode

    node apps/node/miner.mjs --address <43-char address> --vdf server
    node apps/node/miner.mjs --address wYnRY0GUYWkoisS45Djguy5DZ5Xt3z1bE0KDPnq66c4 --sample data/sample-block.json

## Checks

    npm ci --ignore-scripts          # test-only dependencies, pinned
    npm test                         # every test/*.test.mjs: block 2,040,257, RandomX, VDF,
                                     # transactions and ANS-104 against reference libraries
    npm run build && npm run test:page   # the built page, opened from disk
                                     # (PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome)

`scripts/live-network-check.mjs` tries every live request the page makes against real gateways and
nodes; the GitHub workflow runs it on each push (it reports without blocking the build). A
found solution is not yet turned into a signed block.
