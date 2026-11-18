# Weave Tab Miner

An Arweave (replica 2.9) mining node that runs in a browser tab, or in Node, built
library-first. It uses Arweave's real RandomX, compiled to WebAssembly, for H0 and for
packing, and is checked against mainnet block 2,040,257: replaying that block's VDF steps,
it finds the block's own solution again.

## Use it

Build the page, then open `weave-tab-miner.html` by double-clicking it. No web server or
Python needed.

    node scripts/build-single-file.mjs

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

## Files

| File | What it holds |
|---|---|
| `src/miner.js` | Constants, SHA-256, VDF, difficulty, packing layout, H0/H1/H2, the miner, odds |
| `src/randomx.js`, `src/workers/randomx-worker.js` | Real H0 and packing entropy through `vendor/randomx-arweave` |
| `src/storage.js` | Packed chunks in IndexedDB |
| `src/peers.js` | Direct node access and when it is blocked |
| `src/vdf-client.js` | Reading steps from VDF servers (GET /vdf) |
| `src/citations.js` | Links from each rule to the node source |
| `src/gateway.js` | HTTP: blocks, chunks, wallets, prices, transactions |
| `src/wallet.js`, `src/transaction.js` | Keys and signed data transactions |
| `index.html`, `apps/browser/app.js`, `src/workers/vdf-worker.js` | The page |
| `scripts/build-single-file.mjs` | Joins everything into `weave-tab-miner.html` |
| `apps/node/miner.mjs` | Server mode, same library |
| `vendor/randomx-arweave/` | randomx.js built for Arweave, with its patch and build notes |
| `data/sample-block.json` | Block 2,040,257 with its recall chunks and solution preimage |

## Server mode

    node apps/node/miner.mjs --address <43-char address> --vdf server
    node apps/node/miner.mjs --address wYnRY0GUYWkoisS45Djguy5DZ5Xt3z1bE0KDPnq66c4 --sample data/sample-block.json

## Checks

    node test/against-block.test.mjs data/sample-block.json   # SHA-256, VDF, difficulty, layout
    node test/randomx-against-block.test.mjs             # real H0, real packing, the block's own solution
    node test/vdf-update.test.mjs                        # GET /vdf parsing
    npm ci --ignore-scripts                         # test-only dependencies, pinned
    node test/transactions.test.mjs .             # transactions against arweave-js
    node test/check-page.cjs                             # the built page, opened from disk
                                                    # (PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome)

`scripts/live-network-check.mjs` tries every live request the page makes against real gateways and
nodes; the GitHub workflow runs it on each push (it reports without blocking the build). A
found solution is not yet turned into a signed block.
