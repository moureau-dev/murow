import { describe, expect, test } from "bun:test";
import { generateId } from "./generate-id";

describe("generateId", () => {
  test("should generate an ID with default length of 16", () => {
    const id = generateId();
    expect(id.length).toBe(16);
  });

  test("should generate a hexadecimal string", () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  test("should generate unique IDs", () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(1000);
  });

  test("should include prefix when provided", () => {
    const prefix = "user_";
    const id = generateId({ prefix });
    expect(id.startsWith(prefix)).toBe(true);
  });

  test("should maintain total size including prefix", () => {
    const prefix = "user_";
    const size = 20;
    const id = generateId({ prefix, size });
    expect(id.length).toBe(size);
    expect(id.startsWith(prefix)).toBe(true);
  });

  test("should generate custom size without prefix", () => {
    const size = 32;
    const id = generateId({ size });
    expect(id.length).toBe(size);
  });

  test("should enforce minimum of 8 hex characters", () => {
    const prefix = "verylongprefix_";
    const size = 10; // shorter than prefix + 8
    const id = generateId({ prefix, size });
    // Should be prefix + at least 8 hex chars
    expect(id.length).toBeGreaterThanOrEqual(prefix.length + 8);
  });

  test("should pad ID to desired length", () => {
    const size = 24;
    const id = generateId({ size });
    expect(id.length).toBe(size);
  });

  test("should generate different IDs on consecutive calls", () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });

  test("should work with various prefix lengths", () => {
    const prefixes = ["a", "ab", "abc", "player_", "super_long_prefix_"];
    prefixes.forEach((prefix) => {
      const id = generateId({ prefix });
      expect(id.startsWith(prefix)).toBe(true);
    });
  });

  test("should generate valid hex with leading zeros preserved", () => {
    // Generate many IDs to ensure padding works correctly
    for (let i = 0; i < 100; i++) {
      const id = generateId({ size: 16 });
      expect(id.length).toBe(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
