# Weave Tab Miner

An Arweave (replica 2.9) mining node that runs in a browser tab, or in Node, built
library-first. It uses Arweave's real RandomX, compiled to WebAssembly, for H0 and for
packing; follows the chain as a light client; and turns a real solution into a signed block
posted to nodes. Checked against mainnet: it finds block 2,040,257's own solution again,
its account state matches each new block's root, and a real block rebuilt from its
solution comes out with the same id.

## Use it

Build the page, then open `dist/weave-tab-miner.html` by double-clicking it. No web server or
Python needed.

    npm run build

**Start mining for the shared account** does everything: finds sources, loads the live
block, fetches and packs data toward "Storage to use", takes VDF steps from every server
that answers, and gets ready to publish. The sample block (bundled, for networks that block
Arweave) replays its own solution with "Verify against the sample".

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
- **VDF**: the network makes about one step a second; each public VDF server measured
  about 0.6, some in bursts, so the page polls every server that answers and merges their
  steps. Computing steps in the tab is about 20 times slower, too slow to publish.
- **Publishing** needs Arweave nodes directly (plain http): the downloaded copy, or an https
  copy with insecure content allowed for the site. Each visit reads all accounts (about
  300,000) from a node once, then follows each block.
- **What limits the wait** shows the expected time to a solution and what limits it most.
- **Step explorer** shows every value of a mining step, each linked to the line of the
  Arweave node source (commit `18d402c`) that defines it.

## Layout

The library (`src/`) has no runtime dependencies and runs in a page or in Node. It is
grouped by area; each file holds one concern and opens with a line saying what it is.

| Path | What it holds |
|---|---|
| `src/index.js` | Re-exports everything; lists the folders |
| `src/core/` | `bytes.js` byte helpers · `sha256.js` and `sha384.js` synchronous hashes · `secp256k1.js` recovering a signer's key · `denomination.js` · `constants.js` consensus constants · `pretty-number.js` formatting · `citations.js` links from each rule to the node's source |
| `src/mining/` | `vdf.js` VDF steps and sessions · `difficulty.js` · `identity.js` the mining address · `packing.js` replica 2.9 layout and packing · `mining-math.js` H0, recall ranges, H1, H2 · `held-storage.js` held chunks, read from disk on demand · `miner.js` one step against held data · `odds.js` expected wait and why · `randomx.js` real RandomX through `vendor/` · `workers/` the VDF and RandomX web workers |
| `src/blocks/` | Building, publishing and following blocks: `account-tree.js` accounts and their root · `account-tree-snapshot.js` saving and loading it with its hashes · `rewards.js` · `history.js` history hashes · `fields.js` plain fields · `adjustments.js` difficulty retargets and price adjustments · `vdf-info.js` the VDF steps since the parent · `solution.js` · `assembler.js` · `hash.js` signed hash and id · `signing-guard.js` · `signer.js` · `binary.js` the form nodes accept · `block-transactions.js` a block's transactions, fees and account changes · `transaction-picker.js` choosing pending ones a block can carry · `block-publisher.js` solution to posted block · `chain-follower.js` keeping state by following blocks · `network-rules.js` what a localnet relaxes, and what that lets a miner do |
| `src/network/` | `gateway.js` HTTP to gateways · `node-client.js` what nodes serve for chain state, and posting blocks · `erlang-term.js` the node's binary term format · `peers.js` finding and testing sources · `vdf-client.js` VDF servers and the steps seen · `chunk-fetcher.js` fetching chunks in parallel · `pending-transactions.js` a node's pending transactions, kept fresh · `network-target.js` the mainnet or a localnet named in the page address |
| `src/storage/` | `browser-object-store.js` one IndexedDB store, failing softly · `chunk-store.js` packed chunks in IndexedDB, export and import · `chain-state-store.js` the followed chain state between visits · `chunk-share.js` moving chunks between copies of the page |
| `src/wallet/` | `wallet.js` RSA keys · `transaction.js` signed transactions · `bundle.js` ANS-104 items for Turbo |
| `apps/browser/` | The page: `index.html`; `app.js` (startup, identity, RandomX, wiring) and one panel module per page section — `sources-panel.js`, `holding-panel.js`, `mining-panel.js`, `publishing-panel.js`, `records-panel.js`, `quick-start-panel.js` — whose methods join the app's; `page-view.js`, `step-explorer.js`, `resources.js` |
| `apps/node/miner.mjs` | Server mode, same library |
| `scripts/` | The single-file build (follows imports, so new modules need no list), source gathering, the live network check, the localnet workflow's capture, post, and page run (with the proxy a page needs to reach a localnet node), page screenshots |
| `test/` | Tests (`*.test.mjs`, run by `npm test`; the localnet ones read the `localnet-fixtures` branch, `mainnet-blocks.test.mjs` needs the network), the page check, and `fixtures/` |
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
nodes; the GitHub workflow runs it on each push (it reports without blocking the build),
with `test/mainnet-blocks.test.mjs`'s quick checks. Daily, the workflow also follows mainnet
from every account, rebuilds a real block from its solution, and measures the VDF's pace.
