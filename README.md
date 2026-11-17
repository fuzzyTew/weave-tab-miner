# Weave Tab Miner

An Arweave (replica 2.9) mining node that runs in a browser tab, or in Node, built
library-first. It uses Arweave's real RandomX, compiled to WebAssembly, for H0 and for
packing, and is checked against mainnet block 2,040,257: replaying that block's VDF steps,
it finds the block's own solution again.

## Use it

Build the page, then open `weave-tab-miner.html` by double-clicking it. No web server or
Python needed.

    node build_single_file.mjs

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
| `arweave_miner.js` | Constants, SHA-256, VDF, difficulty, packing layout, H0/H1/H2, the miner, odds |
| `arweave_randomx.js`, `randomx_worker.js` | Real H0 and packing entropy through `vendor/randomx-arweave` |
| `arweave_storage.js` | Packed chunks in IndexedDB |
| `arweave_peers.js` | Direct node access and when it is blocked |
| `arweave_vdf_client.js` | Reading steps from VDF servers (GET /vdf) |
| `arweave_citations.js` | Links from each rule to the node source |
| `arweave_gateway.js` | HTTP: blocks, chunks, wallets, prices, transactions |
| `arweave_wallet.js`, `arweave_transaction.js` | Keys and signed data transactions |
| `index.html`, `miner_app.js`, `vdf_worker.js` | The page |
| `build_single_file.mjs` | Joins everything into `weave-tab-miner.html` |
| `node_miner.mjs` | Server mode, same library |
| `vendor/randomx-arweave/` | randomx.js built for Arweave, with its patch and build notes |
| `sample_block.json` | Block 2,040,257 with its recall chunks and solution preimage |

## Server mode

    node node_miner.mjs --address <43-char address> --vdf server
    node node_miner.mjs --address wYnRY0GUYWkoisS45Djguy5DZ5Xt3z1bE0KDPnq66c4 --sample sample_block.json

## Checks

    node test_against_block.mjs sample_block.json   # SHA-256, VDF, difficulty, layout
    node test_randomx_against_block.mjs             # real H0, real packing, the block's own solution
    node test_vdf_update.mjs                        # GET /vdf parsing
    npm install arweave@1.15.5 && node cross_check_transactions.mjs .
    npm install playwright && node check_page.cjs   # the built page, opened from disk

Not yet tested against the live network: gateway, peer and VDF-server requests (the
build machine could not reach Arweave). A found solution is not yet turned into a
signed block.
