# To do

Larger tasks, each opening to its steps. In order of what matters next:

| Task | State |
|---|---|
| Chunks "not found" everywhere | reported: in the downloaded page (file://), chunk requests sometimes got "not found" from every source, though earlier versions filled from nodes. Check the byte position sent (`chunkJson(weaveByte + 1n)`, `storedEndOffset`), partition 9, and how a file:// page's requests are treated |
| Turn a solution into a block | 6 of 7 steps done, and most of mainnet's rules; a real solution left |
| Check what peers and gateways say | started: followed blocks' ids and signatures, and VDF servers' steps by sampling |
| Fetch chunks from nodes that hold them | started: chunk requests rank sources, nodes and gateways alike, by what each has served (SourceRecord). Next, read nodes' `/data_sync_record`, ask the nodes covering each chunk, and keep gateways as the last fallback, so the page does not depend on them |
| Hold a full partition in a tab | measured (scripts/storage-bench.mjs, StorageSizing): the startup key scan passes 60 s near 666 GiB and the in-memory index passes 1 GiB near 3.1 TiB. A compact index (a bitmap of held buckets per partition: about 1.7 MB for a full one, saved as one record) would remove both. Chrome keeps each chunk as its own file (about 14 million for a partition), so storing chunks in larger records (say 64 per record) would also cut per-read overhead |
| Store chunks on an attached drive | not started: Chrome's File System Access API (showDirectoryPicker) can keep chunks as plain files in a folder the person picks, on a USB drive say, outside the browser's allowance and readable by apps/node too; Firefox and Safari would keep using IndexedDB. Meanwhile, a portable browser with its profile on the drive works |
| Faster block replays | the account tree is about 300,000 small objects (some 370 MB live), so garbage collection takes half of mainnet-follow's 4 s; nodes kept in typed arrays (an arena) would cut that, and the page's memory too |
| Reach networks that block Arweave | partly: gathered sources, seeds, a source test |
| Hold more data | mostly done; storage, not memory, is the limit |
| Host the page on Arweave | not started |
| Install it like an app | a PWA (manifest, offline copy); F-Droid not started |
| Be a light client | follows the chain, keeps its state between visits, publishes real solutions with pending transactions; a phone's first read left |
| A simple page | started: storage slider, notes folded; user-story review with screenshots next |
| VDF access and troubleshooting | servers merged; no help yet when none answer |
| Organize for maintenance | review in docs/ARCHITECTURE.md: panels sharing state, app logic to move into the library, packing starving mining |
| Mining together over p2p | planned (docs/ARCHITECTURE.md): secp256k1 block signing, then `src/threshold/` with threshold ECDSA |
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
       - A browser tab, from its one button: the workflow's `page` mode opens the built
         page in headless Chrome at `?localnet=` (a `NetworkTarget`, through
         `scripts/localnet-proxy.mjs`) and waits for the node to take its blocks. The node
         took 5 blocks in a row from the tab, one per VDF step (its own accounts, packing,
         VDF steps and signatures), 157 s from pressing the button. One early run had its
         second block dropped at the node's step-number check; each post now logs its VDF
         facts, and it has not recurred.
       - The VDF difficulty retarget (every 720 heights): the daily capture keeps the newest
         retarget block, and the replay matched block 2,049,120's move from 1,170,436 to
         1,172,665 (`test/mainnet-follow.test.mjs`).
       - Transactions in blocks: mainnet blocks with up to 170 rebuild with their ids, and
         pending transactions are picked on followed state (localnet blocks carry none).
       Left: secp256k1 signing (optional; RSA keys also mine), and the true end: a real
       solution beating the real difficulty, posted to peers, and kept by the network
       against competing blocks.

To continue in a new conversation with Claude, a prompt like this works:

> Continue the weave-tab-miner block builder (github.com/fuzzyTew/weave-tab-miner,
> docs/TODO.md "Turn a solution into a block"). Start at the first unchecked step, test it against the
> localnet-fixtures branch, and commit each step separately.

</details>

<details>
<summary><b>Check what peers and gateways say</b> — today the page believes the first answer</summary>

A malicious node could feed the page a fake block, wrong chunks, wrong VDF steps, a false balance or price, or a peer list of other malicious nodes. Each item says what to check and against what.

#### Blocks
- [x] Recompute a fetched block's `indep_hash` from its fields and check its signature
      (`BlockVerifier`, RSA and secp256k1); `ChainFollower` refuses a block that fails.
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
- [x] Use the chunk's real end offset (GET /chunk's `absolute_end_offset`) where it
      differs from the bucket's, below the strict data split threshold
      (`Replica29Layout.storedEndOffset`).

#### VDF servers
- [x] Check that steps from a VDF server follow, by sampling (`VdfSpotCheck`): every 30 s
      one checkpoint of the newest step is recomputed in a worker; a server that fails is
      dropped (or flagged, if it is the only one).
- [ ] Check the update's seed and upper bound against the current block.
- [x] Use more than one server when several answer (`VdfServerPool` merges their steps);
      comparing their steps is left.

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
- [x] Carry pending transactions (`PendingTransactionPool`, `TransactionPicker`): the page
      keeps a node's pending list fresh and carries what it is sure of; the daily capture
      picks from real pending transactions on the followed state.
- [x] Publish real solutions from the page (`BlockPublisher`, `apps/browser/publishing-panel.js`):
      built on the followed state, signed through the guard, posted to up to 8 nodes as
      text/plain (the only form a browser may send to /block2). Checked by publishing the
      localnet's own blocks byte for byte, and a live mainnet block rebuilt from its
      solution. Needs nodes, so an https copy needs insecure content allowed.
- [x] Keep the chain state between visits (`ChainStateStore`, an `AccountTreeSnapshot` with
      its hashes): a return within 200 blocks catches up block by block instead of reading
      317,000 accounts (tens of MB) and hashing them (about 20 s in Node).
- [ ] Phones: see what an old phone manages for the first read and hash, and the snapshot's
      save (about 1 s in Node, every 10 blocks).
- [ ] Hold the weave's oldest partitions (0–8, below the strict data split threshold), where
      chunks have their own sizes and borders: they are now filed by their own end offset
      (GET /chunk's `absolute_end_offset`), found by containment and packed at their end, as
      a localnet holds them; see one make a mainnet block before the random pick includes them.
- [ ] Shared-key tabs on different devices could each solve at one height and both sign,
      which is double-signing; each tab's guard knows only its own signatures. Rare, so
      postponed until tabs can talk to each other (libp2p or similar).
- [ ] Double-signing proofs in followed blocks (a ban and a prover reward): the follower
      stops and starts over at one.
- [ ] Include pending transactions (GET /tx/pending, then each tx), validated (anchors,
      balances, fees, format) and their fees shared out as the node does, so mined blocks
      carry the community's data and not just empty blocks.

</details>

<details>
<summary><b>A simple page</b> — one slider, the rest folded away</summary>

- [x] A slider for how much of the browser's storage to use, showing how much of it is
      filled; fetching fills toward it, also in the background while mining.
- [x] Notes, the wait breakdown and long explanations fold away (first pass).
- [ ] Review by user stories, with screenshots of each state (`scripts/page-screenshots.mjs`,
      and CI keeps them): "I opened it on a library computer", "my network blocks
      Arweave", "I want data without mining yet", "fetching stalled", "I came back on
      another device". The layout still follows the order this was built in, and the
      states of chunk fetching are hard to read.
- [ ] Getting data should not depend on starting mining: fetching is slow and networks
      are fiddly, so having chunks ready matters on its own.
- [ ] Organize into components a third party can take in quickly, and review all the
      code for consistency with the codebase's intents.

</details>

<details>
<summary><b>VDF access and troubleshooting</b> — one access point reached nodes but no VDF server</summary>

- [x] Poll every VDF server that answers and merge their steps (`VdfServerPool`): each
      public server ran at about 0.6 steps a second, the network at about 1.
- [ ] When none answers: show each server tried and why it failed (timeout, refused,
      blocked as mixed content), and what to try, in order: another server address, the
      downloaded copy, computing steps here (too slow to publish), Tor or another network.
      Seen in use: nodes and gateways answered but VDF requests timed out; running the
      whole phone through Tor worked, but is heavy just for VDF.
- [ ] A field for a VDF server address, remembered, and finding more: VDF servers are
      ordinary nodes configured to serve; ask peers, and record any found in the
      gathered sources.
- [ ] Later, with p2p (below): tabs that can reach a server relay steps to those that
      cannot.

</details>

<details>
<summary><b>Mining together over p2p</b> — after the rest is stable and in manageable components</summary>

- [ ] A p2p layer (libp2p, which runs in browsers over WebRTC and WebTransport) for tabs
      to share the work of polling VDF servers and gossiping steps and blocks back to
      nodes (keeping the network's view of them good), and to coordinate who holds which
      chunks and the expected mining time.
- [ ] Mining with less trusted strangers through threshold signing: no one tab holds the
      key; a set of them must agree to sign a block, which also stops two blocks being
      signed at one height. Base it on a well-studied scheme with a published
      implementation. Arweave keys are RSA-PSS or secp256k1 ECDSA; for ECDSA the studied
      threshold schemes are GG18/GG20, CGGMP21 and DKLs23 (Rust implementations exist
      that could build to WebAssembly). FROST (RFC 9591) is the simplest well-studied one
      but makes Schnorr signatures, which Arweave does not accept today.
- [ ] Where p2p overlaps the official node's functions, mirror them; where it does not
      (for example a way to name peers that are not reachable over HTTP), shape it as a
      possible contribution upstream.

</details>

<details>
<summary><b>Install it like an app</b> — a PWA, then an F-Droid package</summary>

- [x] Progressive web app: `apps/browser/pwa/` holds a manifest, icons
      (`scripts/pwa_icons.py`) and a service worker that keeps a copy of the page, network
      first, for opening offline; the Pages site carries them and the page registers the
      worker when served over http(s). Storage stays per origin, so an installed copy
      shares the site's held chunks. Not yet tried on a phone's home screen.
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
