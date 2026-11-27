# Architecture

How the code is organized, what to keep true as it grows, what a review found, and where
it is headed: a threshold-signing module next, and in the long run a storage library, for
several networks and in several languages, that apps use to keep their users' data safe
off the device, with this page as one demonstration.

Right now the aim is a codebase that is organized, stable and easy to maintain. The
sections below are in that order: rules, the current shape, what to fix, then the plans.

## Rules

These come from the earlier software-architecture discussion and from this project.

- **Library first.** Anything an app does that another app could use lives in `src/`,
  with tests; `apps/` only wires the library to a page or a command line. When a feature
  needs app code to grow, the general part moves into the library first.
- **One owner per piece of state.** Each changing value has one class that holds it and
  changes it; others ask, or are told through an event. (Today's largest exception is
  the page's panels; see Findings.)
- **Functional core.** Where it fits, state is the result of applying a list of inputs
  (blocks, steps, actions) to a starting state: `ChainFollower` is this for accounts,
  `AccountTreeSnapshot` is its saved form, and both make tests replayable from fixtures.
- **No logic at global scope.** A file defines classes; an entry point's last line is one
  call to its class's `main` (`BrowserNodeApp.main()`, `ServerMiner.main(...)`).
- **Competing approaches side by side, behind one interface**, rather than one replacing
  another unseen (VDF steps: `ComputedVdfSteps`, `RecordedVdfSteps`, a server pool).
- **Say so when a change would split or tangle the code**, and improve the library
  instead of branching an app.
- **Fast checks.** Each test runs in well under a second where it can, a few seconds
  where real RandomX must run; the whole local suite is under a minute. Slow work is
  captured once (fixtures, snapshots) and replayed.
- **Every network fact is checked against a real node**: fixtures captured from mainnet
  and a localnet, and a localnet that must take what the page builds.

## Current shape

```
apps/browser   the page: app.js and six panels mixed into it
apps/node      a command-line miner
   │ uses everything below
src/storage    IndexedDB stores (chunks, chain state), moving chunks between copies
src/network    gateways, nodes, peers, VDF servers and spot checks, chunk fetching,
               pending transactions, which network (mainnet or a localnet)
src/blocks     accounts, rewards, histories, VDF info, building, signing, checking,
               publishing and following blocks, picking transactions, network rules
src/mining     VDF, packing, RandomX, held storage, the miner, odds
src/wallet     keys, transactions, ANS-104 data items
src/core       bytes, SHA-256/384, secp256k1, constants, citations
```

Measured on 2026-11-25: imports only point down this list (`network` also uses
`mining`'s VDF and packing layout, and `blocks`' network rules); there are no import
cycles (`test/library-layers.test.mjs` keeps both true); `src/index.js` exports every
module, which `test/library-index.test.mjs` keeps true. All of `src/` except `core/` and `storage/` is Arweave-specific.

## Findings

From reading the code and from screenshots of each stage of the one-button start
(`scripts/page-story.mjs`, the manual "Page story" workflow, kept on the `page-story`
branch).

### Fixed in this review

- Seven modules were missing from `src/index.js`; a test now keeps the index complete.
- Logic ran at global scope in three files (the page's panel mixing, the command-line
  entry, a shared hasher); each now lives in its class.
- The one-button start reported it was getting ready to publish while the publishing
  line asked the person to press another button, because no node addresses were bundled
  with that copy. Publishing now looks for peers itself.
- Chrome reports a site's quota as its usage plus 10 GiB, not its real limit; the page
  read that as a 10 GiB cap. It now says so and lets an amount past it be typed.
- Smaller texts: a button that named Firefox's limit on Chrome, an eight-line storage
  note, an out-of-date claim under "What is real here".
- Sixteen tests carried the same reporting code; they now extend `test/test-case.mjs`.

### To do, in order

1. **Panels share one bag of state.** The six panels are mixed into one app object and
   share about fifty fields on it (`session`, `follower`, `holdStopper`, `awaitedTip`…);
   none has an owner, so a change in one panel can break another unseen. Plan: each
   panel becomes a controller object that owns its state and is given what it needs (a
   small context: the view, the network target, the gateway, the identity) and reports
   changes through events. One panel at a time, publishing first (most self-contained),
   each step with the page check and a localnet page run passing.
   - Publishing: done. Its state and logic moved to `src/network/publishing-node.js`
     (PublishingNode: chain state, nodes, pending transactions, signer), owned by one
     field, `publishing`; the panel keeps only what is the page's (when publishing is
     allowed, which nodes, the status line). The same pattern suits the others: what a
     node program would also need goes to the library, and the panel adapts it.
   - Storage rules went the same way (StorageAllowance, StorageSizing).
   - VDF steps: done. `src/mining/step-sources.js` has the three sources (replay, servers,
     computed) behind one shape and the loop that mines them (StepMiningLoop), tested
     with stand-ins; the panel supplies the pool, the worker and the status text.
   - Filling: done. `src/network/chunk-filler.js` (ChunkFiller) picks positions, fetches,
     packs, holds and saves a batch at a time; the panel says how to save and what to
     show. The node program now uses it and the step sources too, instead of its own
     copies of those loops.
2. **Move app logic the library should own.** From `holding-panel.js` (620 lines, the
   largest file): reading the browser's allowance, including Chrome's floating figure,
   becomes `src/storage/storage-allowance.js`; deciding how much to fetch and when to
   go on becomes a fill policy beside `ChunkFetcher`. From `mining-panel.js`: the three
   VDF step sources (server pool, a worker computing steps, replay) become one
   `StepSource` interface the mining loop takes, so the loop is testable without a page.
3. **Packing starved mining.** In the page-story run the tab mined 122 of about 240
   steps in four minutes, because background packing and each step's H0 share one
   RandomX worker, which answered in order. `RandomxWorkerHost` now keeps one request in
   the worker and sends H0 before waiting entropies, and the pace note says how much
   packing slowed H0 (StepPace.packingEffect, in `src/mining/step-pace.js`). Done; a
   later page-story run mined 279 steps in its first 5 minutes while filling.

## User stories

Each is checked by a script where it can be, and by the page-story screenshots.

- **A newcomer presses the one button.** Sources, the live block, 64 chunks packed,
  VDF steps from a server, mining, ready to publish, each stage listed with what to do if
  it fails. Checked by the page story (mainnet) and the localnet page run (blocks taken).
- **Someone sets how much to hold.** Slider or a typed amount; the note says what the
  browser allows and whether it keeps the data. Chrome's figure floats; Firefox's is a
  limit until the browser agrees to keep the site's data.
- **A returning visitor.** Held chunks and the chain state come back from the browser;
  within a day the state catches up block by block instead of reading every account.
- **A lab or library computer.** Storage may be cleared, persistence refused, nodes
  blocked by the network: the page says which, and export and import move held chunks.
- **A phone.** Not yet measured: the first account read and hash, and whether the
  installed app keeps its storage.
- **A developer using the library.** Everything is exported from `src/index.js`; the
  README's layout lists each module. Missing: a short guide with one example per task.
- **(Later) An app keeping its users' data.** See the storage library below.

## Next: threshold signing as its own module

Tabs sharing a key on different devices could each sign a block at one height, which
gets the key banned. A threshold key fixes this by construction: a block needs a quorum
of devices to sign, so only one block per height can get a signature.

- **Scheme.** Arweave takes block signatures from RSA-PSS or secp256k1 ECDSA keys, not
  Schnorr, so FROST (RFC 9591) does not apply to blocks. Threshold ECDSA does: DKLs23
  (Silence Laboratories' implementation, audited by Trail of Bits) or CGGMP21 (the
  `cggmp21` crate, audited by Kudelski, which leaves networking to the caller as a
  stream of incoming messages and a sink for outgoing ones). Both are Rust, so in the
  page they would run as WebAssembly, as RandomX does now.
- **Prerequisite.** `BlockSigner` signs with RSA keys only; it first needs secp256k1
  block signing (the verifier already checks such blocks, from the localnet).
- **Where it goes.** `src/threshold/`, with no Arweave imports: a `ThresholdSigner`
  interface (key generation among parties, signing a message) and a transport interface
  (messages in, messages out). First implementation: one party holding the whole key,
  marked as a stub, so `BlockSigner` takes a signer interface instead of a wallet. Then
  the WebAssembly scheme over a test transport between tabs (BroadcastChannel), then
  over libp2p between devices.
- **Mirroring the official node.** Where a p2p client needs something the node does not
  offer (peers that are not HTTP servers, say), propose it upstream rather than diverge.

## Later: a storage library for apps, several networks, several languages

The long-term product: a library app developers use to keep their users' data safe off
the device, by storing it on networks such as Arweave and by sharing storage between
users' own devices (a peer-to-peer CDN), with this page as one demonstration.

- **Layers**, each a separate module with its own tests:
  1. core: bytes, hashes, keys, Merkle proofs (today's `src/core/`);
  2. records: a user's data as signed, content-addressed items, independent of any network;
  3. network adapters, one per network: store, find, prove and pay (Arweave first, from
     today's `blocks/`, `network/`, `wallet/`; others such as Autonomi, Filecoin or Crust
     later), each optionally offering a way to contribute storage, as mining does here;
  4. sharing: devices holding each other's encrypted pieces, with proofs they still do;
  5. the app-facing API: save a record, get receipts from each network, load it back.
- **Reorganizing by network** (tried once and reverted, because only one page section
  used the interface): `src/core/` for what every network shares, `src/networks/arweave/`
  for today's Arweave code, `src/networks/<other>/` later, and the page using `core`
  interfaces throughout. Done when a second network is actually added, not before.
- **Several languages.** The formats and protocols are defined once, with conformance
  vectors: captured inputs and expected outputs as plain files, like this repository's
  mainnet and localnet fixtures. Each language's implementation runs the same vectors
  (JavaScript here; Python by way of `pyarweave`; others later), so ports stay in step
  without sharing code.
