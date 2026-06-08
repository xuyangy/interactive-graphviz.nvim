import { afterEach, describe, expect, test } from "bun:test";
import { animationsEnabledWith, getAnimate, setAnimate } from "./animate";

afterEach(() => {
  // Reset module-level animate flag between tests (default is true).
  setAnimate(true);
});

describe("animate config gate (Decision D1, AC4/AC5)", () => {
  test("defaults to true (zero-config keeps interactivity polished)", () => {
    expect(getAnimate()).toBe(true);
  });

  test("setAnimate toggles the resolved value", () => {
    setAnimate(false);
    expect(getAnimate()).toBe(false);
    setAnimate(true);
    expect(getAnimate()).toBe(true);
  });

  test("clamps non-boolean input to the current default (never breaks rendering)", () => {
    // From default true, a bad value must NOT flip the gate.
    setAnimate("nope" as unknown);
    expect(getAnimate()).toBe(true);
    setAnimate(undefined as unknown);
    expect(getAnimate()).toBe(true);
    setAnimate(0 as unknown);
    expect(getAnimate()).toBe(true);
    // After an explicit false, a bad value must NOT flip it back on.
    setAnimate(false);
    setAnimate(1 as unknown);
    expect(getAnimate()).toBe(false);
    setAnimate(null as unknown);
    expect(getAnimate()).toBe(false);
  });
});

describe("animationsEnabledWith — effective decision (AC5)", () => {
  test("config on AND not reduced-motion → animate", () => {
    expect(animationsEnabledWith(true, false)).toBe(true);
  });

  test("config off → instant regardless of reduced-motion", () => {
    expect(animationsEnabledWith(false, false)).toBe(false);
    expect(animationsEnabledWith(false, true)).toBe(false);
  });

  test("reduced-motion → instant even when config is on (accessibility)", () => {
    expect(animationsEnabledWith(true, true)).toBe(false);
  });
});
