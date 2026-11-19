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

The library (`src/`) has no runtime dependencies and runs in a page or in Node. It is
grouped by area; each file holds one concern and opens with a line saying what it is.

| Path | What it holds |
|---|---|
| `src/index.js` | Re-exports everything; lists the folders |
| `src/core/` | `bytes.js` byte helpers · `sha256.js` synchronous SHA-256 · `constants.js` consensus constants · `pretty-number.js` formatting · `citations.js` links from each rule to the node's source |
| `src/mining/` | `vdf.js` VDF steps and sessions · `difficulty.js` · `identity.js` the mining address · `packing.js` replica 2.9 layout and packing · `mining-math.js` H0, recall ranges, H1, H2 · `held-storage.js` held chunks, read from disk on demand · `miner.js` one step against held data · `odds.js` expected wait and why · `randomx.js` real RandomX through `vendor/` · `workers/` the VDF and RandomX web workers |
| `src/blocks/` | Turning a solution into a block: `account-tree.js` · `rewards.js` · `history.js` history hashes · `fields.js` plain fields · `solution.js` · `assembler.js` · `hash.js` signed hash and id · `signing-guard.js` · `signer.js` · `binary.js` the form nodes accept |
| `src/network/` | `gateway.js` HTTP to gateways and nodes · `peers.js` finding and testing sources · `vdf-client.js` VDF servers · `chunk-fetcher.js` fetching chunks in parallel |
| `src/storage/` | `chunk-store.js` packed chunks in IndexedDB, export and import · `chunk-share.js` moving chunks between copies of the page |
| `src/wallet/` | `wallet.js` RSA keys · `transaction.js` signed transactions · `bundle.js` ANS-104 items for Turbo |
| `apps/browser/` | The page: `index.html`; `app.js` (startup, identity, RandomX, wiring) and one panel module per page section — `sources-panel.js`, `holding-panel.js`, `mining-panel.js`, `records-panel.js` — whose methods join the app's; `page-view.js`, `step-explorer.js`, `resources.js` |
| `apps/node/miner.mjs` | Server mode, same library |
| `scripts/` | The single-file build (follows imports, so new modules need no list), source gathering, the live network check, localnet capture |
| `test/` | Tests (`*.test.mjs`, run by `npm test`), the page check, and `fixtures/` |
| `data/` | Build inputs: the sample block, gathered sources, the shared key, the page's permaweb id |
| `vendor/randomx-arweave/` | randomx.js built for Arweave, with its patch and build notes |
| `docs/TODO.md` | Larger tasks, each opening to its steps |

As a library: `import { Miner, DataItem } from 'weave-tab-miner'`, or one module at a time,
`import { DataItem } from 'weave-tab-miner/wallet/bundle'`.

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
