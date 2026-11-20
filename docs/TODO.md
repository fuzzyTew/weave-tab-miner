# To do

Larger tasks, each opening to its steps. In order of what matters next:

| Task | State |
|---|---|
| Turn a solution into a block | 6 of 7 steps done, and most of mainnet's rules; a real solution left |
| Check what peers and gateways say | not started; the page trusts the first answer |
| Reach networks that block Arweave | partly: gathered sources, seeds, a source test |
| Hold more data | mostly done; storage, not memory, is the limit |
| Host the page on Arweave | not started |
| Install it like an app | not started: a PWA, then F-Droid |
| Be a light client | follows the chain, publishes real solutions; pending transactions left |
| A simple page | not started: a storage slider, details folded away, reviewed with screenshots |
| Mine for a pool | not started |
| Network-agnostic design | tried and reverted; plan below |

<details>
<summary><b>Turn a solution into a block</b> — 6 of 7 steps done</summary>

A found solution cannot become a block yet: nothing assembles, signs or sends one. These are
the steps, in order. Each is checked against blocks a real node made, saved on the
`localnet-fixtures` branch by the manual "Localnet fixtures" workflow (3 blocks from
height 2,069,866 with their parents' state, captured).

1. [x] Account tree root: `src/blocks/account-tree.js` rebuilds `wallet_list` from the saved
       304,143 accounts exactly as `ar_patricia_tree` does and matches the parent's root;
       releasing each block's oldest locked reward (`src/blocks/rewards.js`) matches all three
       children's roots (`test/account-tree.test.mjs`). Transactions' account changes and
       redenomination are not handled yet (empty blocks need neither).
2. [x] Rolling hashes: `src/blocks/history.js` computes `reward_history_hash`,
       `block_time_history_hash` and `hash_list_merkle` from the parent alone, matching all
       three saved blocks (`test/block-history.test.mjs`).
3. [x] Plain fields: `src/blocks/fields.js` computes all 24 (height, links, cumulative
       difficulty, the reward from exact-integer inflation and the endowment, pools and
       prices carried) for empty blocks, matching all three saved blocks
       (`test/block-fields.test.mjs`). Stubs that refuse rather than guess: price
       adjustment heights (every 50 blocks), difficulty retargets, redenomination, and
       transactions' fees.
4. [x] Signature preimage and block hash: `src/blocks/hash.js` rebuilds each saved block's
       id from its JSON, and its secp256k1 signature verifies with its own key
       (`test/block-hash.test.mjs`). `src/blocks/signer.js` signs with an RSA key through
       `DoubleSigningGuard` (`test/block-signer.test.mjs`). Not yet: signing with
       secp256k1 keys, and blocks that carry a double-signing proof.
5. [x] Whole blocks: `src/blocks/assembler.js` assembles each saved block from the first
       parent's state and the block's mining solution, advancing the state with its own
       blocks; every field matches the node's, and with the node's signature so does the
       id (`test/block-assembler.test.mjs`).
6. [x] Localnet acceptance: `src/blocks/binary.js` encodes a block to the binary
       `POST /block2` takes, identical byte for byte to the node's own
       (`test/block-binary.test.mjs`). The "Localnet fixtures" workflow's `post` mode
       (`scripts/localnet-post.mjs`) mines with a fresh RSA key, packs one sub-chunk with
       real RandomX (`src/blocks/solution.js`, `test/block-solution.test.mjs`), builds each
       block on its parent's VDF step and posts it; the node took 3 of 3 in a row as its
       tip. Small chunks are zero-padded to 256 KiB, as the node proves them.
7. [ ] Mainnet. Done, each checked where a node checks it:
       - VDF steps between the parent's and the block's, seeds and bounds across reset
         lines (`src/blocks/vdf-info.js`): the localnet took blocks 1 and 2 computed steps
         ahead; all three saved blocks' `nonce_limiter_info` and a mainnet block's match.
       - Two-chunk (H2) solutions (`BlockSolution`): saved block 2,069,867 matches; the
         localnet took ours.
       - Difficulty retargets and price adjustments, including the 2.7.2 price transition
         mainnet is still in (`src/blocks/adjustments.js`): the localnet took 37 blocks in
         a row across a price adjustment; the localnet never retargets, so retargets are
         checked against live mainnet blocks (`test/mainnet-blocks.test.mjs`, 6 of 6, and a
         price adjustment).
       Left: the VDF difficulty retarget (every 720 heights; written, not yet met by a
       test), secp256k1 signing (optional; RSA keys also mine), transactions in blocks
       (empty blocks only so far), and the true end: a real solution beating the real
       difficulty, posted to peers, and kept by the network against competing blocks.

To continue in a new conversation with Claude, a prompt like this works:

> Continue the weave-tab-miner block builder (github.com/fuzzyTew/weave-tab-miner,
> docs/TODO.md "Turn a solution into a block"). Start at the first unchecked step, test it against the
> localnet-fixtures branch, and commit each step separately.

</details>

<details>
<summary><b>Check what peers and gateways say</b> — today the page believes the first answer</summary>

A malicious node could feed the page a fake block, wrong chunks, wrong VDF steps, a false balance or price, or a peer list of other malicious nodes. Each item says what to check and against what.

#### Blocks
- [ ] Recompute a fetched block's `indep_hash` from its fields and check its signature.
- [ ] Check its proof of work: H0 from its VDF output, the recall bytes, H1/H2 from its
      packed sub-chunks, and that the solution passes its difficulty (the library already
      does all of this for block 2,040,257).
- [ ] Check its VDF: recompute at least the last step from `prev_output`, and spot-check
      checkpoints of earlier steps in a worker.
- [ ] Follow `previous_block` back to a block already trusted (a checkpoint shipped with
      the page), checking each link, before mining on a new tip.
- [ ] Prefer the tip most peers agree on; treat a block only one source reports as unconfirmed.

#### Chunks
- [ ] Check each fetched chunk against its `data_path` and `tx_path`: the Merkle proofs from
      the chunk to its transaction's `data_root`, and from that to the block's `tx_root`.
      Today a fake chunk would only waste packing time, since solutions from it fail
      validation, but it would also make the expected-wait figures wrong.
- [ ] Use the chunk's real end offset from its proof instead of the bucket of the byte
      asked for (the approximation noted in `apps/browser/app.js`).

#### VDF servers
- [ ] Check that each step from a VDF server follows from the previous one, at least by
      sampling: recompute one checkpoint per step in a worker and drop the server on a mismatch.
- [ ] Check the update's seed and upper bound against the current block.
- [ ] Use more than one server when several answer, and compare their steps.

#### Peers
- [ ] Ask several gateways for peer lists, not one.
- [ ] Drop peers whose `/info` height or current block disagrees with the majority.
- [ ] Rate-limit and cap how many peers are probed, so a peer list cannot make the page
      flood the network.

#### Wallets, prices and transactions
- [ ] Get balances and prices from at least two independent sources and show a warning
      when they differ.
- [ ] After sending a transaction, confirm it from a different source than the one it was
      sent to.
- [ ] Check a transaction anchor (`/tx_anchor`) is a recent block or transaction we know of.
- [ ] History from peers instead of GraphQL, which has not been reliable: (1) remember what
      this page sent and confirm each with `GET /tx/{id}/status` (or the bundle holding a
      data item, once Turbo reports it); (2) follow `GET /wallet/{address}/last_tx` and
      older transactions' `last_tx` anchors where they chain; (3) scan blocks from a known
      height (when the key was made), reading each block's transactions' headers, and
      parsing bundles to see data items. GraphQL would become a hint to check, not the source.
- [ ] Compare a wallet's history across sources. GraphQL "received" for the same address
      gave 0 on arweave.net and 2 on turbo-gateway.com: show both and say which is behind.

</details>

<details>
<summary><b>Reach networks that block Arweave</b> — and networks that do not speak HTTP</summary>

- [ ] Optional Tor transport, for networks that block Arweave hosts: tor-js (Arti compiled
      to WebAssembly, `fetch()`-like) through Snowflake WebSocket bridges, or webtor-rs.
      Off by default: it is several MB, slow to start, and bridges or gateways may block it
      too. Plug it in as a `fetch` the gateway and peer classes take.
- [ ] Beyond HTTP: Tor would also let a page reach any TCP port, so clients for other
      storage networks could be written, prices compared and data mirrored. libp2p in the
      browser (WebRTC, WebTransport) reaches libp2p networks such as Autonomi. Chrome's
      Direct Sockets API gives raw TCP, but only to installed Isolated Web Apps.

</details>

<details>
<summary><b>Hold more data</b> — storage, not memory, is now the limit</summary>

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

</details>

<details>
<summary><b>Host the page on Arweave</b> — needs chunked upload</summary>

- [ ] Upload the page itself to Arweave from the page: it is about 1 MB, so it needs the
      chunked upload (`POST /tx` without data, then `POST /chunk` per 256 KiB with its
      `data_path`), which `DataTransaction` does not do yet. Then record the id in
      `data/permaweb.json`.

</details>

<details>
<summary><b>Be a light client</b> — practical on a phone, and useful to the network</summary>

- [x] Mine on the current chain: seeds and weave bound from each VDF server update, and
      the tip block fetched each minute (before, the page mined the block it loaded at
      the start, so solutions went invalid at the next reset line, ~20 minutes).
      Not yet: the same for "compute VDF in this tab" mode, whose seeds still come from
      the loaded block.
- [x] What nodes serve for accounts (ar_http_iface_middleware.erl, recorded in
      `src/network/node-client.js`): every account by root in pages, and single balances;
      no per-account proofs, so a partial tree cannot be checked against a root. A browser
      must read the pages in Erlang's term format (`src/network/erlang-term.js`): asking
      for JSON needs a header nodes give no CORS permission for there.
- [x] Keep state by watching blocks (`ChainFollower`): every account once (317,041 on
      mainnet, hashed and checked against the block's root), then each new block's
      transactions (secp256k1 senders recovered from their signatures, as nodes do) and
      released reward, each checked against the block's root, on live mainnet blocks.
- [x] Publish real solutions from the page (`BlockPublisher`, `apps/browser/publishing-panel.js`):
      built on the followed state, signed through the guard, posted to up to 8 nodes as
      text/plain (the only form a browser may send to /block2). Checked by publishing the
      localnet's own blocks byte for byte, and a live mainnet block rebuilt from its
      solution. Needs nodes, so an https copy needs insecure content allowed.
- [ ] Phones: reading 317,000 accounts takes tens of MB and about a minute of hashing;
      keep the tree in IndexedDB between visits, and see what an old phone manages.
- [ ] Double-signing proofs in followed blocks (a ban and a prover reward): the follower
      stops and starts over at one.
- [ ] Include pending transactions (GET /tx/pending, then each tx), validated (anchors,
      balances, fees, format) and their fees shared out as the node does, so mined blocks
      carry the community's data and not just empty blocks.

</details>

<details>
<summary><b>A simple page</b> — one slider, the rest folded away</summary>

- [ ] A slider for how much of the browser's storage to use, showing how much of it is
      filled; holding, packing and mining follow from it.
- [ ] Everything verbose (settings, explanations, the step explorer, logs) inside
      expandable sections, popups or tabs, so a newcomer sees a few plain controls first.
- [ ] Review all the code and the page for consistency with the codebase's intents and
      the architecture discussed so far, and check the page with screenshots for what a
      new person would understand at a glance.

</details>

<details>
<summary><b>Install it like an app</b> — a PWA, then an F-Droid package</summary>

- [ ] Progressive web app: a manifest and a service worker that caches the page, so it
      installs from the browser, opens offline and keeps mining from a home-screen icon.
      Storage stays per origin, so an installed copy shares the site's held chunks.
- [ ] F-Droid: a small Android app (a WebView around the single-file page, or a
      Trusted Web Activity) built from source with no proprietary libraries, so F-Droid
      can build and sign it. Helps old phones with free storage hold data.

</details>

<details>
<summary><b>Mine for a pool</b> — the pool signs; the block's tags record who helped</summary>

- [ ] Pool mode: mine to a pool's address and send solutions to the pool, which records the
      local miner's address in the signed block's `tags` (up to 2,048 bytes), so anyone can
      check the pool paid them.

</details>

<details>
<summary><b>Network-agnostic design</b> — tried and reverted</summary>

- [ ] Network-agnostic design (tried and reverted: a storage-network interface used by
      one page section only, while everything else stayed Arweave code). Done properly it
      would reorganize the library by network, e.g. `src/core/` (keys, records, transports,
      storage in the browser), `src/networks/arweave/` (gateway, peers, transactions,
      bundles, mining, packing, VDF, block building) and `src/networks/<other>/`, with
      the page choosing networks through `core` interfaces throughout: identity,
      balances and history, storing and reading records. Mining stays per network.

</details>
