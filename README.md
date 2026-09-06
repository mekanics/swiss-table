# Swiss Table

A faithful, from-scratch implementation of Google's [Swiss Table](https://abseil.io/about/design/swisstables) (Abseil `flat_hash_map`) in TypeScript.

**Status: teaching implementation.** This repo exists to make the Swiss Table design legible — control bytes, H2 hash fragments, group probing, tombstones, and open addressing. It is **not a production `Map` replacement**. See the benchmarks below.

## What it is

This is a readable, tested (36/36) port of the Abseil Swiss Table to pure TypeScript:

- **Control bytes** (`Uint8Array`): one byte per slot.
  - `0x80` — empty (slot never used)
  - `0xFE` — tombstone (slot was deleted)
  - `0x00–0x7F` — occupied; the low 7 bits store an H2 fragment of the key's hash
- **Open addressing**: keys live in a flat array; collisions are resolved by probing forward.
- **16-slot group probing**: the code checks 16 control bytes per probe step to mirror the SSE/AVX group width used by Abseil. In TypeScript this is simulated with sequential loads and branches — the abstraction is preserved, the SIMD is not.
- **Load factor**: the table grows when `(size + tombstones) / capacity ≥ 7/8` (87.5%).
- **Tombstone cleanup**: when tombstones exceed half the capacity, an in-place rehash reclaims them.
- **Power-of-2 capacity**: enables `hash & mask` instead of `% capacity`.
- **Hash function**: [cyrb53](https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js), a fast non-cryptographic hash. **It is hardcoded with seed = 0 and is not HashDoS-resistant.**

## Usage

```typescript
import { SwissTable } from "./src/swiss-table.js";

const table = new SwissTable<string, number>();
table.set("hello", 42);
console.log(table.get("hello")); // 42
console.log(table.size);          // 1
table.delete("hello");
console.log(table.has("hello"));  // false
```

## API

| Method | Description |
|--------|-------------|
| `set(key, value)` | Insert or update. Returns `true` if new, `false` if updated. |
| `get(key)` | Look up. Returns `V \| undefined`. |
| `has(key)` | Check existence. Returns `boolean`. |
| `delete(key)` | Tombstone deletion. Returns `true` if found. |
| `clear()` | Remove all entries. |
| `size` (getter) | Number of active entries. |
| `[Symbol.iterator]()` | Yields `[K, V]` pairs in slot order. |
| `entries()` | Array of `[K, V]` pairs. |
| `keysArray()` | Array of keys. |
| `valuesArray()` | Array of values. |

## Benchmarks: SwissTable vs. built-in `Map`

Measured on a Raspberry Pi 5, Node.js 24.16.0, V8 13.6.233.17-node.49 (best of 5 reps, forced GC between phases, checksums to prevent dead-code elimination). Lower is better. Ratios show how much slower SwissTable is.

**1,000,000 entries:**

| Operation | `Map` (ms) | SwissTable (ms) | Ratio |
|---|---|---|---|
| `set`, 33-char string keys | 906 | 1,840 | **2.0×** |
| `get`, hits (strings) | 601 | 822 | **1.4×** |
| `get`, misses (strings) | 497 | 620 | **1.2×** |
| `has`, hits (strings) | 532 | 664 | **1.25×** |
| build + delete half (strings) | 962 | 1,881 | **2.0×** |
| `set`, uint32 keys | 555 | 1,279 | **2.3×** |
| `get`, hits (uint32) | 458 | 708 | **1.5×** |
| `set`, object keys | 581 | 2,049 | **3.5×** |
| `get`, hits (objects) | 354 | 818 | **2.3×** |
| `get`, hits (1–2 char string keys) | 503 | 504 | **≈ tie** |
| Heap after build (strings) | 29.3 MB | 33.6 MB | Map wins |

**100,000 and 10,000 entries:** same pattern. `Map` wins every workload; SwissTable only ties when string keys are so short that the hash loop becomes negligible.

**Conclusion:** for general-purpose key/value work in JavaScript, use the built-in `Map`. It is faster on every measured workload, uses less heap at scale, and is insertion-ordered.

## Why it cannot beat `Map` in JavaScript

The Swiss Table was designed for C++, where three things are true:

1. **Real SIMD:** Abseil scans 16 control bytes with ~3 SSE instructions (`_mm_set1_epi8`, `_mm_cmpeq_epi8`, `_mm_movemask_epi8`). JavaScript has no user-space SIMD; the SIMD.js proposal was withdrawn and never shipped. The 16-slot group in this repo is a sequential loop of 16 loads and branches — the abstraction without the physics.
2. **Cache and layout control:** C++ can pack keys and values into a flat, cache-line-aligned slot array. V8 decides object layout for you; JS arrays hold tagged pointers, not dense structs.
3. **Cached, engine-level hashes:** V8 caches string hashes in the string header and hides object identity hashes in object headers. Every `SwissTable.get` re-runs `cyrb53` over the key (and for numbers/objects, allocates a string first). The hash function, not the probing, is the dominant cost.

On top of that, V8's TurboFan inlines `Map.prototype.get`/`has`/`set` into optimized machine code. A userland class method cannot outrun an engine that has already done the optimization at the C++ layer.

## The fun fact: Swiss Tables already run under your JavaScript

This design is not theoretical. The exact same Swiss Table algorithm powers production runtimes:

- **V8** adopted `SwissNameDictionary` in 2021 for dictionary-mode object property storage.
- **Go 1.24** rebuilt its built-in map on Swiss Tables.
- **Rust**'s standard library `HashMap` is `hashbrown`, a Swiss Table.

This repo lets you read the design in TypeScript; the real thing runs inside V8/Go/Rust at the C++/assembly tier with real SIMD and engine-managed layout.

## When *would* a custom hash table make sense in JS?

Not for replacing `Map`, but a few real niches exist:

- **Value-equality keys:** you need `{x: 1, y: 2}` to match a *different* object with the same contents. `Map` uses SameValueZero (reference equality for objects). A custom table with injected `hash`/`equals` is the right tool. *This repo currently does not support that; it hashes objects by reference identity.*
- **Fixed-size binary keys in flat Buffers:** when the table is backed by typed arrays and you avoid GC pressure (e.g. the `ronomon/hash-table` pattern).
- **Inside WebAssembly:** real `v128` SIMD, no JS↔Wasm boundary crossings per op.
- **Deterministic layout/reproducible hashing:** unseeded `cyrb53` and fixed probing make the table fully deterministic across runs — useful for tests, snapshots, or Merkle-style sync, though sorting keys is usually a better answer.

For everything else: `new Map()`.

## Caveats

- **Not HashDoS-resistant.** `cyrb53` runs unseeded (seed = 0). Do not use this table with attacker-influenced keys (HTTP headers, query params, JSON keys, etc.).
- **Not insertion-ordered.** Iteration follows slot order, not insertion order. It is therefore not a drop-in semantic replacement for `Map`.
- **Not production-tuned.** The 87.5% load factor and 16-slot groups are inherited from the C++ design; in JS, where probing is not SIMD-free, a lower load factor would likely be more defensible.

## Testing

```bash
pnpm install
pnpm test
```

36 tests covering basic operations, delete/tombstones, growth and rehashing, iteration, and edge cases (NaN, objects, symbols, bigint, null/undefined, mixed stress).

## License

MIT
