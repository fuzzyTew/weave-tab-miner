# randomx.js built for Arweave

`randomx-arweave.iife.js` is [randomx.js](https://github.com/l1mey112/randomx.js) at commit
`7d2f099` with `randomx-js-arweave.patch` applied, built for browsers and bundled as one
classic script defining `RandomxArweave`.

## What the patch adds

- **`pkg-randomx-arweave.js/configuration.toml`**: the parameters of Arweave's H0 RandomX
  ("rx4096" in `apps/arweave/lib/Makefile`, values from `ArweaveTeam/RandomX`
  `src/configuration.h`). Arweave's fork is not standard RandomX: its Argon2 salt is
  `RandomX-Arweave\x01`, its cache 512 MiB, its dataset 4 GiB plus 31,563,008 bytes, and
  its instruction frequencies and 4-round AES keys are RandomWOW's, while program size and
  count are Monero's.
- **`configuration-squared.toml`**: the same, with the "squared" build's 2 GiB dataset and
  2 MiB scratchpad at every level, for packing.
- **`src/vm_rx2/`**: Arweave's replica 2.9 packing entropy (`rsp_fused_entropy` in
  `apps/arweave/c_src/randomx/randomx_squared.cpp`): 4 lanes, depth 3, 6 programs per lane,
  CRC-32C near mix and 6-byte far mix.
- **`src/jit/jit_vm.c`**: the dataset address mask is written as a signed 32-bit constant.
  A 4 GiB dataset's mask, `0xFFFFFFC0`, does not fit `i32.const` otherwise, and the module
  would be rejected. Upstream's Monero and RandomWOW test vectors still pass.
- Two tests against mainnet block 2,040,257 (see also `../../test_randomx_against_block.mjs`).

## Rebuild

Needs clang with the wasm32 target, wasm-ld, bun, wabt, and binaryen 119 or newer
(older `wasm-opt` cannot read relaxed-SIMD; `npm install binaryen@119.0.0` provides one —
put it first on `PATH`, as clang runs `wasm-opt` itself).

    git clone https://github.com/l1mey112/randomx.js && cd randomx.js
    git checkout 7d2f099 && git apply ../randomx-js-arweave.patch
    bun install
    make $(ls src/detect/*.wat | sed 's/wat$/wasm/') \
         pkg-randomx-arweave.js/dataset.wasm pkg-randomx-arweave.js/vm.wasm pkg-randomx-arweave.js/rx2vm.wasm
    NOMAKE=1 bun scripts/build.ts      # builds every package; the others' wasm must exist too
    npx esbuild pkg-randomx-arweave.js/dist/web/index.js --bundle --format=iife \
        --global-name=RandomxArweave --outfile=randomx-arweave.iife.js

## Speed (Node 22, one core of this build machine)

- 512 MiB cache: about 2 s
- one H0: about 0.07 s
- one 8 MiB packing entropy: about 0.8 s, so about 26 s for the 32 entropies one chunk needs;
  chunks at the same position in other sectors reuse them.
