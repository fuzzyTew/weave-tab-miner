# Weave Tab Miner

An Arweave (replica 2.9) mining node that runs in a browser tab or in Node, built library-first.

## Files

| File | What it holds |
|---|---|
| `arweave_miner.js` | Consensus constants, SHA-256, VDF, difficulty, packing layout, H0/H1/H2, the `Miner`, odds |
| `arweave_gateway.js` | HTTP access to gateways: blocks, chunks, balances, history, prices, posting transactions |
| `arweave_wallet.js` | An RSA-4096 Arweave key in memory: generate, load a keyfile, sign |
| `arweave_transaction.js` | Format-2 data transactions: data root, deep hash, signing, JSON |
| `index.html`, `miner_app.js`, `vdf_worker.js` | The page |
| `node_miner.mjs` | Server mode, same library |
| `sample_block.json` | Mainnet block 2,040,257 with its two recall chunks, for offline use |
| `test_against_block.mjs` | Checks the library against that block |

## Run the page

Browsers refuse ES modules from `file://`, so serve the folder:

    python3 -m http.server 8000      # then open http://localhost:8000/

## Run server mode

    node node_miner.mjs --address <43-char address> --vdf follow
    node node_miner.mjs --address <address> --sample sample_block.json --aim-at-held --test-ease 1000000000

## Check it

    node test_against_block.mjs sample_block.json
    npm install arweave@1.15.5 && node cross_check_transactions.mjs .

Passes today: SHA-256 against node:crypto; a full mainnet VDF step recomputed to the block's
output; the block's solution hash passing the difficulty check; recall bytes, partition and
entropy layout; the unpacked chunk hash. Transactions were separately cross-checked against
arweave-js 1.15.5: data root (including the last-chunk split), deep hash, signature, id and
keyfile address all match, and arweave-js verifies transactions signed here.

## Stand-ins

- `StubH0Hasher`: SHA-256 in place of RandomX "rx4096" (Arweave's fork, `RANDOMX_ARGON_MEMORY=524288`,
  `RANDOMX_DATASET_BASE_SIZE=4294967296`, key `default arweave 2.5 pack key`).
- `StubEntropySource`: SHA-256 counter mode in place of the "RandomX squared" 8 MiB entropy.

Replace either with a WebAssembly build of `ArweaveTeam/RandomX` plus `c_src/randomx/randomx_squared.cpp`;
the interfaces are `hash(preimage)` and `entropySlice(entropyKey, sliceIndex)`. Until then any solution
found would be rejected by the network.

Not tested against the live network (no network access where this was built): gateway endpoints,
CORS, posting transactions.
