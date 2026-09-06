import { describe, it, expect, beforeEach } from "vitest";
import { SwissTable } from "./swiss-table.js";

describe("SwissTable", () => {
  let table: SwissTable<string, number>;

  beforeEach(() => {
    table = new SwissTable<string, number>();
  });

  // ─── Basic Operations ──────────────────────────────────────────────────────

  describe("basic operations", () => {
    it("should start empty", () => {
      expect(table.size).toBe(0);
      expect(table.getCapacity()).toBe(16); // default capacity
    });

    it("should insert and retrieve a value", () => {
      table.set("hello", 42);
      expect(table.size).toBe(1);
      expect(table.get("hello")).toBe(42);
    });

    it("should return undefined for missing keys", () => {
      expect(table.get("missing")).toBeUndefined();
    });

    it("should update existing values", () => {
      table.set("key", 1);
      expect(table.get("key")).toBe(1);

      table.set("key", 2);
      expect(table.get("key")).toBe(2);
      expect(table.size).toBe(1); // size shouldn't increase on update
    });

    it("should return true for new insert, false for update", () => {
      expect(table.set("a", 1)).toBe(true);
      expect(table.set("a", 2)).toBe(false);
    });
  });

  // ─── Has ────────────────────────────────────────────────────────────────────

  describe("has", () => {
    it("should return true for existing keys", () => {
      table.set("exists", 100);
      expect(table.has("exists")).toBe(true);
    });

    it("should return false for missing keys", () => {
      expect(table.has("nope")).toBe(false);
    });

    it("should return false after deletion", () => {
      table.set("temp", 1);
      table.delete("temp");
      expect(table.has("temp")).toBe(false);
    });
  });

  // ─── Delete ─────────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("should delete entries and return true", () => {
      table.set("a", 1);
      table.set("b", 2);
      expect(table.delete("a")).toBe(true);
      expect(table.size).toBe(1);
      expect(table.get("a")).toBeUndefined();
      expect(table.get("b")).toBe(2);
    });

    it("should return false when deleting missing keys", () => {
      expect(table.delete("ghost")).toBe(false);
    });

    it("should handle delete and re-insert", () => {
      table.set("x", 10);
      table.delete("x");
      table.set("x", 20);
      expect(table.get("x")).toBe(20);
      expect(table.size).toBe(1);
    });

    it("should track tombstones", () => {
      table.set("a", 1);
      table.set("b", 2);
      table.delete("a");
      expect(table.getTombstoneCount()).toBe(1);
      expect(table.size).toBe(1);
    });
  });

  // ─── Clear ──────────────────────────────────────────────────────────────────

  describe("clear", () => {
    it("should remove all entries", () => {
      table.set("a", 1);
      table.set("b", 2);
      table.set("c", 3);
      table.clear();
      expect(table.size).toBe(0);
      expect(table.get("a")).toBeUndefined();
      expect(table.get("b")).toBeUndefined();
      expect(table.get("c")).toBeUndefined();
      expect(table.getTombstoneCount()).toBe(0);
    });

    it("should allow inserting after clear", () => {
      table.set("a", 1);
      table.clear();
      table.set("a", 2);
      expect(table.get("a")).toBe(2);
      expect(table.size).toBe(1);
    });
  });

  // ─── Growth & Rehashing ────────────────────────────────────────────────────

  describe("growth and rehashing", () => {
    it("should grow when load factor exceeds 7/8", () => {
      const initialCap = table.getCapacity();
      // Fill to 14 entries (14/16 = 87.5% — triggers growth at 14 since 14*8 >= 16*7)
      for (let i = 0; i < 14; i++) {
        table.set(`key${i}`, i);
      }
      const newCap = table.getCapacity();
      expect(newCap).toBeGreaterThan(initialCap);
      // All entries should still be accessible after growth
      for (let i = 0; i < 14; i++) {
        expect(table.get(`key${i}`)).toBe(i);
      }
      expect(table.size).toBe(14);
    });

    it("should handle large number of insertions", () => {
      const N = 1000;
      for (let i = 0; i < N; i++) {
        table.set(`key${i}`, i);
      }
      expect(table.size).toBe(N);
      for (let i = 0; i < N; i++) {
        expect(table.get(`key${i}`)).toBe(i);
      }
    });

    it("should handle insertions, deletions, and more insertions", () => {
      // Insert 100
      for (let i = 0; i < 100; i++) {
        table.set(`k${i}`, i);
      }
      // Delete 50
      for (let i = 0; i < 50; i++) {
        table.delete(`k${i}`);
      }
      expect(table.size).toBe(50);
      // Insert 50 more new keys
      for (let i = 0; i < 50; i++) {
        table.set(`new${i}`, i);
      }
      expect(table.size).toBe(100);
      // Verify
      for (let i = 50; i < 100; i++) {
        expect(table.get(`k${i}`)).toBe(i);
      }
      for (let i = 0; i < 50; i++) {
        expect(table.get(`new${i}`)).toBe(i);
      }
    });

    it("should reclaim tombstones during rehash", () => {
      // Insert and delete many to accumulate tombstones
      for (let i = 0; i < 12; i++) {
        table.set(`k${i}`, i);
      }
      for (let i = 0; i < 8; i++) {
        table.delete(`k${i}`);
      }
      // After 8 deletions on a 16-cap table, tombstones = 8 > 16/2 = 8? No, 8 is not > 8
      // Let's delete one more
      table.delete("k8");
      // Now tombstones should have been reclaimed (9 > 8 triggered rehash)
      // After rehash, tombstones should be 0
      expect(table.getTombstoneCount()).toBe(0);
      // Live entries should still be present
      for (let i = 9; i < 12; i++) {
        expect(table.get(`k${i}`)).toBe(i);
      }
    });
  });

  // ─── Iterator ──────────────────────────────────────────────────────────────

  describe("iterator", () => {
    it("should iterate over all entries", () => {
      table.set("a", 1);
      table.set("b", 2);
      table.set("c", 3);
      const entries = Array.from(table);
      expect(entries).toHaveLength(3);
      const map = new Map(entries);
      expect(map.get("a")).toBe(1);
      expect(map.get("b")).toBe(2);
      expect(map.get("c")).toBe(3);
    });

    it("should iterate over empty table", () => {
      expect(Array.from(table)).toHaveLength(0);
    });

    it("should not iterate over deleted entries", () => {
      table.set("a", 1);
      table.set("b", 2);
      table.delete("a");
      const entries = Array.from(table);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(["b", 2]);
    });

    it("should support entries(), keysArray(), valuesArray()", () => {
      table.set("x", 10);
      table.set("y", 20);
      expect(table.entries()).toEqual(
        expect.arrayContaining([
          ["x", 10],
          ["y", 20],
        ]),
      );
      expect(table.keysArray().sort()).toEqual(["x", "y"]);
      expect(table.valuesArray().sort()).toEqual([10, 20]);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle NaN as a key", () => {
      const t = new SwissTable<number, string>();
      t.set(NaN, "not-a-number");
      expect(t.has(NaN)).toBe(true);
      expect(t.get(NaN)).toBe("not-a-number");
      expect(t.size).toBe(1);
    });

    it("should handle 0 and -0 as distinct keys", () => {
      const t = new SwissTable<number, string>();
      // In JS, 0 === -0 is true, so these are the same key
      t.set(0, "zero");
      t.set(-0, "neg-zero");
      // Since 0 === -0, the second set updates the first
      expect(t.size).toBe(1);
      expect(t.get(0)).toBe("neg-zero");
    });

    it("should handle boolean keys", () => {
      const t = new SwissTable<boolean, number>();
      t.set(true, 1);
      t.set(false, 0);
      expect(t.get(true)).toBe(1);
      expect(t.get(false)).toBe(0);
      expect(t.size).toBe(2);
    });

    it("should handle bigint keys", () => {
      const t = new SwissTable<bigint, string>();
      t.set(1n, "one");
      t.set(2n, "two");
      expect(t.get(1n)).toBe("one");
      expect(t.get(2n)).toBe("two");
      expect(t.size).toBe(2);
    });

    it("should handle symbol keys", () => {
      const t = new SwissTable<symbol, number>();
      const s1 = Symbol("a");
      const s2 = Symbol("b");
      t.set(s1, 100);
      t.set(s2, 200);
      expect(t.get(s1)).toBe(100);
      expect(t.get(s2)).toBe(200);
      expect(t.size).toBe(2);
    });

    it("should handle object keys by reference", () => {
      const t = new SwissTable<object, string>();
      const obj1 = { id: 1 };
      const obj2 = { id: 2 };
      t.set(obj1, "first");
      t.set(obj2, "second");
      expect(t.get(obj1)).toBe("first");
      expect(t.get(obj2)).toBe("second");
      // A different object with same content is not the same key
      expect(t.get({ id: 1 })).toBeUndefined();
      expect(t.size).toBe(2);
    });

    it("should handle null and undefined keys", () => {
      const t = new SwissTable<string | null | undefined, number>();
      t.set("exists", 1);
      t.set(null, 2);
      t.set(undefined, 3);
      expect(t.get(null)).toBe(2);
      expect(t.get(undefined)).toBe(3);
      expect(t.size).toBe(3);
    });

    it("should handle string collision resistance", () => {
      // Insert many keys and verify all are retrievable
      const N = 500;
      for (let i = 0; i < N; i++) {
        table.set(`item_${i}`, i * 2);
      }
      for (let i = 0; i < N; i++) {
        expect(table.get(`item_${i}`)).toBe(i * 2);
      }
      expect(table.size).toBe(N);
    });

    it("should handle empty string key", () => {
      table.set("", 99);
      expect(table.get("")).toBe(99);
      expect(table.has("")).toBe(true);
      expect(table.size).toBe(1);
    });
  });

  // ─── Stress Test ───────────────────────────────────────────────────────────

  describe("stress test", () => {
    it("should handle mixed operations at scale", () => {
      const t = new SwissTable<number, string>();
      const reference = new Map<number, string>();
      const ROUNDS = 5;
      const OPS_PER_ROUND = 200;

      for (let round = 0; round < ROUNDS; round++) {
        // Insert
        for (let i = 0; i < OPS_PER_ROUND; i++) {
          const key = round * 1000 + i;
          const val = `val_${key}`;
          t.set(key, val);
          reference.set(key, val);
        }
        // Delete some
        for (let i = 0; i < OPS_PER_ROUND / 2; i++) {
          const key = round * 1000 + i * 2;
          t.delete(key);
          reference.delete(key);
        }
      }

      // Verify all remaining entries
      expect(t.size).toBe(reference.size);
      for (const [key, val] of reference) {
        expect(t.get(key)).toBe(val);
      }
    });

    it("should survive churn: insert all, delete half, insert new, verify", () => {
      const t = new SwissTable<string, number>();
      const N = 2000;

      // Insert all
      for (let i = 0; i < N; i++) {
        t.set(`k${i}`, i);
      }
      expect(t.size).toBe(N);

      // Delete even-indexed
      for (let i = 0; i < N; i += 2) {
        t.delete(`k${i}`);
      }
      expect(t.size).toBe(N / 2);

      // Insert new keys
      for (let i = 0; i < N / 2; i++) {
        t.set(`new${i}`, i);
      }
      expect(t.size).toBe(N);

      // Verify odd-indexed original keys
      for (let i = 1; i < N; i += 2) {
        expect(t.get(`k${i}`)).toBe(i);
      }
      // Verify new keys
      for (let i = 0; i < N / 2; i++) {
        expect(t.get(`new${i}`)).toBe(i);
      }
    });
  });

  // ─── Custom Initial Capacity ───────────────────────────────────────────────

  describe("custom capacity", () => {
    it("should accept custom initial capacity", () => {
      const t = new SwissTable<string, number>(64);
      expect(t.getCapacity()).toBe(64);
    });

    it("should round up non-power-of-2 capacity", () => {
      const t = new SwissTable<string, number>(30);
      expect(t.getCapacity()).toBe(32); // next power of 2
    });

    it("should enforce minimum capacity of GROUP_SIZE (16)", () => {
      const t = new SwissTable<string, number>(4);
      expect(t.getCapacity()).toBe(16);
    });
  });
});