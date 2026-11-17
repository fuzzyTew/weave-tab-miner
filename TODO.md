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
      asked for (the approximation noted in `miner_app.js`).

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

## Building blocks

- [ ] Assemble an empty block (no transactions) from the previous block: reward and
      block-time histories, difficulty, price, denomination, endowment pool, block-index root.
- [ ] Keep the account tree: download it once (`GET /wallet_list/{root}/{cursor}`, 2,500
      accounts a page), apply each new block, and compute its root as `ar_patricia_tree_core`
      does.
- [ ] Sign the block and send it (`POST /block_announcement`, then `POST /block2`).
- [ ] Test each field by rebuilding a real block from its parent.

## Hosting

- [ ] Upload the page itself to Arweave from the page: it is about 1 MB, so it needs the
      chunked upload (`POST /tx` without data, then `POST /chunk` per 256 KiB with its
      `data_path`), which `DataTransaction` does not do yet. Then record the id in
      `permaweb.json`.

## Pool

- [ ] Pool mode: mine to a pool's address and send solutions to the pool, which records the
      local miner's address in the signed block's `tags` (up to 2,048 bytes), so anyone can
      check the pool paid them.
