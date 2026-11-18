# To do

## Validate what peers and gateways say

Today the page believes whatever the first answering node or gateway returns. A malicious
node could feed it a fake block, wrong chunks, wrong VDF steps, a false balance or price,
or a peer list of other malicious nodes. Each item below says what to check and against what.

### Blocks
- [ ] Recompute a fetched block's `indep_hash` from its fields and check its signature.
- [ ] Check its proof of work: H0 from its VDF output, the recall bytes, H1/H2 from its
      packed sub-chunks, and that the solution passes its difficulty (the library already
      does all of this for block 2,040,257).
- [ ] Check its VDF: recompute at least the last step from `prev_output`, and spot-check
      checkpoints of earlier steps in a worker.
- [ ] Follow `previous_block` back to a block already trusted (a checkpoint shipped with
      the page), checking each link, before mining on a new tip.
- [ ] Prefer the tip most peers agree on; treat a block only one source reports as unconfirmed.

### Chunks
- [ ] Check each fetched chunk against its `data_path` and `tx_path`: the Merkle proofs from
      the chunk to its transaction's `data_root`, and from that to the block's `tx_root`.
      Today a fake chunk would only waste packing time, since solutions from it fail
      validation, but it would also make the expected-wait figures wrong.
- [ ] Use the chunk's real end offset from its proof instead of the bucket of the byte
      asked for (the approximation noted in `apps/browser/app.js`).

### VDF servers
- [ ] Check that each step from a VDF server follows from the previous one, at least by
      sampling: recompute one checkpoint per step in a worker and drop the server on a mismatch.
- [ ] Check the update's seed and upper bound against the current block.
- [ ] Use more than one server when several answer, and compare their steps.

### Peers
- [ ] Ask several gateways for peer lists, not one.
- [ ] Drop peers whose `/info` height or current block disagrees with the majority.
- [ ] Rate-limit and cap how many peers are probed, so a peer list cannot make the page
      flood the network.

### Wallets, prices and transactions
- [ ] Get balances and prices from at least two independent sources and show a warning
      when they differ.
- [ ] After sending a transaction, confirm it from a different source than the one it was
      sent to.
- [ ] Check a transaction anchor (`/tx_anchor`) is a recent block or transaction we know of.
- [ ] Compare a wallet's history across sources. GraphQL "received" for the same address
      gave 0 on arweave.net and 2 on turbo-gateway.com: show both and say which is behind.

### Reaching the network
- [ ] Optional Tor transport, for networks that block Arweave hosts: tor-js (Arti compiled
      to WebAssembly, `fetch()`-like) through Snowflake WebSocket bridges, or webtor-rs.
      Off by default: it is several MB, slow to start, and bridges or gateways may block it
      too. Plug it in as a `fetch` the gateway and peer classes take.
- [ ] Storage networks share one interface (src/networks.js: StorageNetwork, RecordMirror).
      Autonomi is a stub waiting for a libp2p transport; add others the same way, each
      naming the transport it needs.
- [ ] Beyond HTTP: Tor would also let a page reach any TCP port, so clients for other
      storage networks could be written, prices compared and data mirrored. libp2p in the
      browser (WebRTC, WebTransport) reaches libp2p networks such as Autonomi. Chrome's
      Direct Sockets API gives raw TCP, but only to installed Isolated Web Apps.

## Building blocks (next)

A found solution cannot become a block yet: nothing assembles, signs or sends one. These are
the steps, in order. Each is checked against blocks a real node made, saved on the
`localnet-fixtures` branch by the manual "Localnet fixtures" workflow (3 blocks from
height 2,069,866 with their parents' state, captured).

1. [ ] Account tree root: rebuild `wallet_list` from the saved 304,143 accounts exactly as
       `ar_patricia_tree` does, and match the parent block's root. Then apply a block's
       changes (the reward, released locked rewards) and match the child's root.
2. [ ] Rolling hashes: `reward_history_hash`, `block_time_history_hash`, and the block-index
       hash `hash_list_merkle`, from the saved histories.
3. [ ] Small fields: height, previous block, timestamp, `previous_solution_hash`, the
       cumulative difficulty pair, the reward, and carried-over prices and pools.
4. [ ] Signature preimage and block hash (`indep_hash`), signed with the miner's key
       (RSA or secp256k1 ECDSA, both accepted since 2.9), through `DoubleSigningGuard`.
5. [ ] Rebuild each saved localnet block from its parent, field by field, until all match.
6. [ ] Localnet acceptance: a manual workflow posts several blocks our code built in a row
       (`POST /block_announcement`, then `POST /block2`) and reports what the node accepted.
       The localnet skips difficulty and lets a block choose its recall chunks, so every
       step can make a block.
7. [ ] Mainnet: the same, after a real solution.

To continue in a new conversation with Claude, a prompt like this works:

> Continue the weave-tab-miner block builder (github.com/fuzzyTew/weave-tab-miner,
> docs/TODO.md "Building blocks"). Start at the first unchecked step, test it against the
> localnet-fixtures branch, and commit each step separately.

## Holding more data

- [x] Held chunks no longer all sit in memory: saved ones are read from IndexedDB as each
      step needs them (HeldStorage.ensureLoaded), 64 at most kept in memory.
- [ ] Export still gathers every chunk of an address into one file in memory; stream it
      for very large stores.
- [ ] More storage than one site's allowance: browsers give each site its own allowance, so
      the same page opened from several hosts (several Arweave gateways, once the page is
      stored on Arweave; a copy on disk) holds more in all. Each copy picks its own
      partition and mines it; they could share one VDF source.
- [ ] Old phones as miners: plugged in, screen kept on (the page holds a wake lock while
      mining); on-demand reading now lets their free storage count. Try one.

## Hosting

- [ ] Upload the page itself to Arweave from the page: it is about 1 MB, so it needs the
      chunked upload (`POST /tx` without data, then `POST /chunk` per 256 KiB with its
      `data_path`), which `DataTransaction` does not do yet. Then record the id in
      `data/permaweb.json`.

## Pool

- [ ] Pool mode: mine to a pool's address and send solutions to the pool, which records the
      local miner's address in the signed block's `tags` (up to 2,048 bytes), so anyone can
      check the pool paid them.
