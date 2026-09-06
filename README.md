# Swiss Table

A [Swiss Table](https://abseil.io/about/design/swisstables) (Google Abseil-style flat hash map) implementation in TypeScript.

## Design

The Swiss Table is a high-performance hash table design that uses **control bytes** and **SIMD-style group probing** to achieve fast lookups with excellent cache locality.

### Key Concepts

- **Control bytes array** (`Uint8Array`): One byte per slot, encoding:
  - `0x80` (EMPTY) — slot has never been used
  - `0xFE` (DELETED) — slot was deleted (tombstone)
  - `0x00–0x7F` — slot is occupied; the 7 low bits store a fragment of the key's hash

- **Open addressing with linear probing**: Keys are stored in a flat array. Collisions are resolved by probing forward.

- **Group probing (simulated SIMD)**: Instead of checking one slot at a time, we check 16 control bytes per probe step (matching the SSE/AVX SIMD group width). In JavaScript/TypeScript, there's no native SIMD, so we simulate this with batched comparison. This still provides the algorithmic benefit: we skip over non-matching slots faster than byte-at-a-time probing.

- **Dense key/value storage**: Keys and values are stored in parallel arrays alongside the control bytes. There's no per-slot metadata overhead beyond the single control byte.

- **Tombstone-based deletion**: Deleted slots are marked with `0xFE` rather than cleared to `0x80`, allowing probes to continue past deleted slots. Tombstones are reclaimed during rehashing.

### Growth & Rehashing

- **Load factor**: The table grows (doubles capacity) when `(size + tombstones) / capacity ≥ 7/8 (87.5%)`.
- **Tombstone reclamation**: When tombstones exceed half the capacity, an in-place rehash clears them without growing.
- **Power-of-2 capacity**: Always a power of 2, enabling fast `hash & mask` instead of `hash % capacity`.

### Hash Function

Uses [cyrb53](https://github.com/bryc/code/blob/master/jshash/EXPERIMENTAL.md#cyrb53), a fast non-cryptographic hash function with good avalanche properties. No external dependencies.

### Key Equality

- Primitives (`number`, `string`, `boolean`, `bigint`, `symbol`) compared by value
- `NaN` is treated as equal to `NaN`
- Objects compared by reference identity (using a `WeakMap` for stable hashes)

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
| `[Symbol.iterator]()` | Yields `[K, V]` pairs. |
| `entries()` | Array of `[K, V]` pairs. |
| `keysArray()` | Array of keys. |
| `valuesArray()` | Array of values. |

## Testing

```bash
pnpm install
pnpm test
```

36 tests covering: basic operations, delete/tombstones, growth & rehashing, iteration, edge cases (NaN, objects, symbols, bigint, null/undefined), and stress tests with 2000+ mixed operations.

## License

MIT