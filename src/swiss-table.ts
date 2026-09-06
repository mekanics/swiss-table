/**
 * Swiss Table — A Google Abseil-style flat hash map implementation in TypeScript.
 *
 * Design:
 * - Control bytes array (Uint8Array): 1 byte per slot encoding:
 *     0x80 = empty, 0xFE = deleted (tombstone), 0x00-0x7F = occupied (7 low bits of hash)
 * - Open addressing with linear probing — no chaining
 * - SIMD-style batch probing: check 16 control bytes at once (simulated in JS via batched comparison)
 * - Dense key/value storage in parallel arrays — no per-slot metadata beyond the control byte
 * - Growth: rehash when load factor > 7/8 (87.5%)
 * - Tombstone handling: track deletion count, rehash when tombstones exceed capacity/2
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Control byte: slot is empty. */
const EMPTY = 0x80; // 10000000
/** Control byte: slot is a tombstone (deleted). */
const DELETED = 0xfe; // 11111110
/** Mask for the 7 low bits of a hash used in the control byte. */
const HASH_MASK = 0x7f; // 01111111
/** Group size for batch probing — 16 slots at a time (matches SSE SIMD width). */
const GROUP_SIZE = 16;
/** Default initial capacity (must be a power of 2, >= GROUP_SIZE). */
const DEFAULT_CAPACITY = 16;
/** Maximum load factor before resize — 7/8 = 87.5%. */
const MAX_LOAD_NUMERATOR = 7;
const MAX_LOAD_DENOMINATOR = 8;

// ─── Hash Function ───────────────────────────────────────────────────────────

/**
 * cyrb53 — a fast, high-quality hash function with good avalanche properties.
 * Returns a 53-bit integer hash. No external dependencies.
 * @see https://github.com/bryc/code/blob/master/jshash/EXPERIMENTAL.md#cyrb53
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  // Combine to 53-bit result
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Hash any key to a 53-bit number. Converts keys to string representations
 * for hashing, handling special cases like NaN.
 */
function hashKey<K>(key: K): number {
  if (key === null) return cyrb53("null");
  if (key === undefined) return cyrb53("undefined");

  if (typeof key === "number") {
    // Treat NaN as a distinct, consistent key
    if (Number.isNaN(key)) return cyrb53("NaN");
    return cyrb53(String(key));
  }

  if (typeof key === "string") return cyrb53(key);
  if (typeof key === "boolean") return cyrb53(String(key));
  if (typeof key === "bigint") return cyrb53(String(key));
  if (typeof key === "symbol") return cyrb53(key.toString());

  // Objects, arrays, functions: use reference identity
  // We use a WeakMap to assign a stable numeric id per object reference
  return getObjectHash(key as object);
}

// ─── Object Identity Hashing ─────────────────────────────────────────────────

const objectHashMap = new WeakMap<object, number>();
let nextObjectHash = 1;

function getObjectHash(obj: object): number {
  let h = objectHashMap.get(obj);
  if (h === undefined) {
    h = nextObjectHash++;
    objectHashMap.set(obj, h);
  }
  // Mix the object id into a hash
  return cyrb53("obj:" + h);
}

// ─── Key Equality ────────────────────────────────────────────────────────────

function keysEqual<K>(a: K, b: K): boolean {
  if (a === b) return true;
  // NaN === NaN is false, handle explicitly
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  // BigInt
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  // Symbols
  if (typeof a === "symbol" && typeof b === "symbol") return a === b;
  // Objects: reference equality (already covered by === but be explicit)
  return a === b;
}

// ─── SwissTable ──────────────────────────────────────────────────────────────

export class SwissTable<K, V> {
  /** Control bytes — one per slot. */
  private controls: Uint8Array;
  /** Dense key storage — keys[i] is the key at slot i (only valid if controls[i] is occupied). */
  private keys: (K | undefined)[];
  /** Dense value storage — values[i] is the value at slot i. */
  private values: (V | undefined)[];
  /** Current capacity (always a power of 2, >= GROUP_SIZE). */
  private capacity: number;
  /** Number of active entries. */
  private _size: number;
  /** Number of tombstone (deleted) slots. */
  private tombstones: number;
  /** Bit mask for fast modulo: hash & mask === hash % capacity (since capacity is power of 2). */
  private mask: number;

  /**
   * Create a new SwissTable.
   * @param initialCapacity - Must be a power of 2. Defaults to 16.
   */
  constructor(initialCapacity: number = DEFAULT_CAPACITY) {
    // Ensure capacity is a power of 2 and at least GROUP_SIZE
    let cap = Math.max(GROUP_SIZE, initialCapacity);
    cap = nextPowerOf2(cap);
    this.capacity = cap;
    this.mask = cap - 1;
    this.controls = new Uint8Array(cap).fill(EMPTY);
    this.keys = new Array(cap).fill(undefined);
    this.values = new Array(cap).fill(undefined);
    this._size = 0;
    this.tombstones = 0;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Number of active entries in the table. */
  get size(): number {
    return this._size;
  }

  /** Current capacity (total slots). */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Insert or update a key-value pair.
   * Returns true if a new entry was inserted, false if an existing key was updated.
   */
  set(key: K, value: V): boolean {
    const fullHash = hashKey(key);
    const h7 = fullHash & HASH_MASK; // 7-bit hash for control byte

    // Find the slot: either an existing entry with the same key, or an empty/deleted slot to insert into
    const { index, existing } = this.findSlot(key, fullHash, h7);

    if (existing) {
      // Update existing entry
      this.values[index] = value;
      return false;
    }

    // Insert new entry
    this.controls[index] = h7;
    this.keys[index] = key;
    this.values[index] = value;
    this._size++;

    // Check if we need to grow
    if (this.needsResize()) {
      this.grow();
    }

    return true;
  }

  /**
   * Look up a key. Returns the associated value, or undefined if not found.
   */
  get(key: K): V | undefined {
    const fullHash = hashKey(key);
    const h7 = fullHash & HASH_MASK;
    const index = this.probeForKey(key, fullHash, h7);
    if (index === -1) return undefined;
    return this.values[index];
  }

  /**
   * Check if a key exists in the table.
   */
  has(key: K): boolean {
    const fullHash = hashKey(key);
    const h7 = fullHash & HASH_MASK;
    return this.probeForKey(key, fullHash, h7) !== -1;
  }

  /**
   * Delete a key. Returns true if the key was found and deleted, false otherwise.
   * Uses tombstone-based deletion — the slot is marked DELETED, not EMPTY.
   */
  delete(key: K): boolean {
    const fullHash = hashKey(key);
    const h7 = fullHash & HASH_MASK;
    const index = this.probeForKey(key, fullHash, h7);
    if (index === -1) return false;

    // Mark as tombstone
    this.controls[index] = DELETED;
    this.keys[index] = undefined;
    this.values[index] = undefined;
    this._size--;
    this.tombstones++;

    // Rehash if too many tombstones (more than half the capacity)
    if (this.tombstones > this.capacity / 2) {
      this.rehash();
    }

    return true;
  }

  /** Remove all entries and reset to initial capacity. */
  clear(): void {
    this.controls.fill(EMPTY);
    this.keys.fill(undefined);
    this.values.fill(undefined);
    this._size = 0;
    this.tombstones = 0;
  }

  /** Iterate over all [key, value] pairs. */
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (let i = 0; i < this.capacity; i++) {
      if (this.controls[i] !== EMPTY && this.controls[i] !== DELETED) {
        yield [this.keys[i] as K, this.values[i] as V];
      }
    }
  }

  /** Convert to an array of [key, value] pairs. */
  entries(): [K, V][] {
    return Array.from(this);
  }

  /** Get all keys. */
  keysArray(): K[] {
    return Array.from(this, ([k]) => k);
  }

  /** Get all values. */
  valuesArray(): V[] {
    return Array.from(this, ([, v]) => v);
  }

  // ─── Internal: Probing & Slot Finding ──────────────────────────────────────

  /**
   * Probe for a key: walk through control bytes in groups of 16, checking
   * for matching hash bits, then verify full key equality.
   * Returns the slot index if found, -1 if not found.
   *
   * This simulates SIMD group probing: instead of checking one byte at a time,
   * we check all 16 bytes in a group for a match before moving to the next group.
   */
  private probeForKey(key: K, fullHash: number, h7: number): number {
    let pos = fullHash & this.mask;

    for (let probe = 0; probe < this.capacity; probe += GROUP_SIZE) {
      // Check a group of 16 control bytes at once (simulated SIMD)
      const groupStart = pos;
      for (let i = 0; i < GROUP_SIZE; i++) {
        const idx = (groupStart + i) & this.mask;
        const ctrl = this.controls[idx];

        if (ctrl === EMPTY) {
          // Hit an empty slot — key can't exist beyond this point
          return -1;
        }

        // Check if control byte matches our 7-bit hash
        if (ctrl !== DELETED && (ctrl & HASH_MASK) === h7) {
          // Potential match — verify full key equality
          if (keysEqual(this.keys[idx] as K, key)) {
            return idx;
          }
        }
      }

      // Move to next group
      pos = (pos + GROUP_SIZE) & this.mask;
    }

    return -1;
  }

  /**
   * Find a slot for insertion: either an existing entry with the same key,
   * or the first available (empty or tombstone) slot.
   * Returns { index, existing: boolean }.
   */
  private findSlot(key: K, fullHash: number, h7: number): { index: number; existing: boolean } {
    let pos = fullHash & this.mask;
    let firstAvailable = -1;

    for (let probe = 0; probe < this.capacity; probe += GROUP_SIZE) {
      const groupStart = pos;
      for (let i = 0; i < GROUP_SIZE; i++) {
        const idx = (groupStart + i) & this.mask;
        const ctrl = this.controls[idx];

        if (ctrl === EMPTY) {
          // Empty slot — key doesn't exist beyond here. Use this or a earlier tombstone.
          const insertIdx = firstAvailable !== -1 ? firstAvailable : idx;
          return { index: insertIdx, existing: false };
        }

        if (ctrl === DELETED) {
          // Remember first tombstone for insertion
          if (firstAvailable === -1) firstAvailable = idx;
        } else if ((ctrl & HASH_MASK) === h7) {
          // Hash matches — check full key equality
          if (keysEqual(this.keys[idx] as K, key)) {
            return { index: idx, existing: true };
          }
        }
      }

      pos = (pos + GROUP_SIZE) & this.mask;
    }

    // Table is full of tombstones and occupied slots — shouldn't happen if resize logic is correct,
    // but handle gracefully by using the first available tombstone
    if (firstAvailable !== -1) {
      return { index: firstAvailable, existing: false };
    }

    // This should never be reached if load factor management is working
    throw new Error("SwissTable is full — this indicates a bug in resize logic");
  }

  // ─── Internal: Resize & Rehash ─────────────────────────────────────────────

  /**
   * Check if the table needs to grow or rehash.
   * Grows when load factor exceeds 7/8. Rehashes when tombstones are excessive.
   */
  private needsResize(): boolean {
    const load = this._size + this.tombstones;
    // Grow when (size + tombstones) > 7/8 * capacity
    return load * MAX_LOAD_DENOMINATOR >= this.capacity * MAX_LOAD_NUMERATOR;
  }

  /**
   * Grow the table: double the capacity and rehash all entries.
   */
  private grow(): void {
    const newCapacity = this.capacity * 2;
    this.rehashTo(newCapacity);
  }

  /**
   * Rehash in-place: clear tombstones by re-inserting all live entries.
   * Keeps the same capacity.
   */
  private rehash(): void {
    this.rehashTo(this.capacity);
  }

  /**
   * Rehash all live entries into a new table with the given capacity.
   */
  private rehashTo(newCapacity: number): void {
    const oldKeys = this.keys;
    const oldValues = this.values;
    const oldControls = this.controls;
    const oldCapacity = this.capacity;

    // Allocate new arrays
    this.capacity = newCapacity;
    this.mask = newCapacity - 1;
    this.controls = new Uint8Array(newCapacity).fill(EMPTY);
    this.keys = new Array(newCapacity).fill(undefined);
    this.values = new Array(newCapacity).fill(undefined);
    this._size = 0;
    this.tombstones = 0;

    // Re-insert all live entries
    for (let i = 0; i < oldCapacity; i++) {
      const ctrl = oldControls[i];
      if (ctrl !== EMPTY && ctrl !== DELETED) {
        const key = oldKeys[i] as K;
        const value = oldValues[i] as V;
        // Direct insert without recursion
        const fullHash = hashKey(key);
        const h7 = fullHash & HASH_MASK;
        let pos = fullHash & this.mask;

        // Find an empty slot in the new table (guaranteed to succeed since we sized correctly)
        for (;;) {
          const ctrlByte = this.controls[pos];
          if (ctrlByte === EMPTY) {
            this.controls[pos] = h7;
            this.keys[pos] = key;
            this.values[pos] = value;
            this._size++;
            break;
          }
          pos = (pos + 1) & this.mask;
        }
      }
    }
  }

  // ─── Debug Helpers ─────────────────────────────────────────────────────────

  /** Get the number of tombstone slots (for testing/debugging). */
  getTombstoneCount(): number {
    return this.tombstones;
  }

  /** Get the current load factor (0..1). */
  getLoadFactor(): number {
    return (this._size + this.tombstones) / this.capacity;
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Round up to the next power of 2. */
function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  // Bit-twiddling trick
  let p = n - 1;
  p |= p >>> 1;
  p |= p >>> 2;
  p |= p >>> 4;
  p |= p >>> 8;
  p |= p >>> 16;
  p |= p >>> 32;
  return p + 1;
}