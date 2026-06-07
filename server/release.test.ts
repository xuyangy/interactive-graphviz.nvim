import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RELEASE_TARGETS,
  artifactNames,
  generateChecksumManifest,
  releaseProjectPath,
  validateChecksumManifest,
} from "../scripts/release";

describe("release target metadata", () => {
  test("lists every v1 target with stable artifact names", () => {
    expect(artifactNames()).toEqual([
      "server-linux-x64",
      "server-linux-arm64",
      "server-linux-x64-musl",
      "server-linux-arm64-musl",
      "server-darwin-x64",
      "server-darwin-arm64",
      "server-windows-x64.exe",
    ]);

    expect(RELEASE_TARGETS.map((target) => target.bunTarget)).toEqual([
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-linux-x64-musl",
      "bun-linux-arm64-musl",
      "bun-darwin-x64",
      "bun-darwin-arm64",
      "bun-windows-x64",
    ]);
    expect(artifactNames().some((name) => name.includes("windows"))).toBe(true);
  });
});

describe("release project paths", () => {
  test("resolve build inputs from the repository root", async () => {
    expect(await Bun.file(releaseProjectPath("frontend/index.html")).exists()).toBe(true);
    expect(await Bun.file(releaseProjectPath("server/server.ts")).exists()).toBe(true);
    expect(releaseProjectPath("frontend/index.html")).not.toContain(
      "server/frontend/index.html",
    );
  });
});

describe("release checksum manifest", () => {
  test("generates deterministic sha256 lines for every expected artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ig-release-"));
    try {
      for (const name of artifactNames()) {
        await writeFile(join(dir, name), `fixture:${name}`);
      }

      const manifest = await generateChecksumManifest(dir);
      const lines = manifest.trimEnd().split("\n");

      expect(lines).toHaveLength(artifactNames().length);
      expect(lines.map((line) => line.split("  ")[1])).toEqual(artifactNames());
      expect(lines.every((line) => /^[a-f0-9]{64}  server-/.test(line))).toBe(true);
      expect(validateChecksumManifest(manifest)).toEqual({ ok: true, errors: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing and unexpected manifest artifacts", () => {
    const manifest = [
      `${"0".repeat(64)}  server-linux-x64`,
      `${"1".repeat(64)}  server-freebsd-x64`,
    ].join("\n");

    const result = validateChecksumManifest(manifest);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("missing"))).toBe(true);
    expect(result.errors.some((error) => error.includes("unexpected"))).toBe(true);
  });
});

describe("release workflow", () => {
  test("publishes only tagged v1 assets with committed checksum verification", async () => {
    const workflow = await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text();

    expect(workflow).toContain("tags:");
    expect(workflow).toContain('"v*"');
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("--verify-against checksums.txt");
    expect(workflow).toContain('gh release create "$RELEASE_TAG"');
    expect(workflow).toContain("--verify-tag");
    expect(workflow).not.toContain("--clobber");
    expect(workflow).toContain("server-windows-x64.exe");

    for (const name of artifactNames()) {
      expect(workflow).toContain(`dist/release/${name}`);
    }
  });
});
