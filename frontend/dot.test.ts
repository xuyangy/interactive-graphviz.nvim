import { describe, expect, test } from "bun:test";
import { isBlankDot } from "./dot";

describe("isBlankDot (Story 4.1 AC2 — empty-DOT detection)", () => {
  test("undefined / null / empty string are blank", () => {
    expect(isBlankDot(undefined)).toBe(true);
    expect(isBlankDot(null)).toBe(true);
    expect(isBlankDot("")).toBe(true);
  });

  test("whitespace-only is blank", () => {
    expect(isBlankDot("   \n\t  ")).toBe(true);
  });

  test("real DOT is not blank (even with surrounding whitespace)", () => {
    expect(isBlankDot("digraph{a->b}")).toBe(false);
    expect(isBlankDot("  graph G {}  ")).toBe(false);
  });
});
