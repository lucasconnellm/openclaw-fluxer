import { describe, expect, it } from "vitest";
import { hasPermissionBits, normalizePermissionBits } from "./permissions.js";

describe("normalizePermissionBits", () => {
  it("normalizes numbers, bigint, strings, and bitfield objects", () => {
    expect(normalizePermissionBits(7)).toBe(7n);
    expect(normalizePermissionBits(7n)).toBe(7n);
    expect(normalizePermissionBits("7")).toBe(7n);
    expect(normalizePermissionBits({ bitfield: "7" })).toBe(7n);
  });

  it("rejects invalid values", () => {
    expect(() => normalizePermissionBits(-1)).toThrow();
    expect(() => normalizePermissionBits(1.1)).toThrow();
    expect(() => normalizePermissionBits("   ")).toThrow();
    expect(() => normalizePermissionBits(undefined)).toThrow();
  });
});

describe("hasPermissionBits", () => {
  it("checks required bits across mixed input types", () => {
    expect(hasPermissionBits(7, 3)).toBe(true);
    expect(hasPermissionBits("7", 1n)).toBe(true);
    expect(hasPermissionBits({ bitfield: 4 }, 2)).toBe(false);
  });
});
