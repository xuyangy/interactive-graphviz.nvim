import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseTarget = {
  artifactName: string;
  bunTarget: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

export const RELEASE_TARGETS: ReleaseTarget[] = [
  { artifactName: "server-linux-x64", bunTarget: "bun-linux-x64" },
  { artifactName: "server-linux-arm64", bunTarget: "bun-linux-arm64" },
  { artifactName: "server-linux-x64-musl", bunTarget: "bun-linux-x64-musl" },
  { artifactName: "server-linux-arm64-musl", bunTarget: "bun-linux-arm64-musl" },
  { artifactName: "server-darwin-x64", bunTarget: "bun-darwin-x64" },
  { artifactName: "server-darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { artifactName: "server-windows-x64.exe", bunTarget: "bun-windows-x64" },
];

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function releaseProjectPath(...segments: string[]): string {
  return join(PROJECT_ROOT, ...segments);
}

export function artifactNames(): string[] {
  return RELEASE_TARGETS.map((target) => target.artifactName);
}

export async function generateChecksumManifest(outDir: string): Promise<string> {
  const lines = [];

  for (const artifactName of artifactNames()) {
    const artifactPath = join(outDir, artifactName);
    const data = await readFile(artifactPath);
    const digest = createHash("sha256").update(data).digest("hex");
    lines.push(`${digest}  ${artifactName}`);
  }

  return `${lines.join("\n")}\n`;
}

export function validateChecksumManifest(manifest: string): ValidationResult {
  const expected = new Set(artifactNames());
  const seen = new Set<string>();
  const errors: string[] = [];
  const trimmed = manifest.trim();
  const lines = trimmed.length === 0 ? [] : trimmed.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const match = /^([a-f0-9]{64})  ([^\s]+)$/.exec(line);
    if (!match) {
      errors.push(`line ${index + 1} is not '<sha256>  <artifact-name>'`);
      continue;
    }

    const artifactName = match[2];
    if (!expected.has(artifactName)) {
      errors.push(`unexpected artifact in manifest: ${artifactName}`);
    }
    if (seen.has(artifactName)) {
      errors.push(`duplicate artifact in manifest: ${artifactName}`);
    }
    seen.add(artifactName);
  }

  for (const artifactName of expected) {
    if (!seen.has(artifactName)) {
      errors.push(`missing artifact in manifest: ${artifactName}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function validateReleaseDirectory(outDir: string, manifest: string): Promise<ValidationResult> {
  const errors = [...validateChecksumManifest(manifest).errors];
  const expected = new Set(artifactNames());
  const entries = await readdir(outDir);
  const unexpectedBinaries = entries.filter((entry) => entry.startsWith("server-") && !expected.has(entry));

  for (const artifactName of expected) {
    if (!entries.includes(artifactName)) {
      errors.push(`missing binary in release directory: ${artifactName}`);
    }
  }

  for (const artifactName of unexpectedBinaries) {
    errors.push(`unexpected binary in release directory: ${artifactName}`);
  }

  return { ok: errors.length === 0, errors };
}

export async function buildReleaseArtifacts(outDir: string): Promise<void> {
  const resolvedOutDir = resolve(outDir);

  await mkdir(resolvedOutDir, { recursive: true });
  await runCommand(["bun", "build", "frontend/index.html", "--outdir", "dist/frontend"]);

  for (const target of RELEASE_TARGETS) {
    await runCommand([
      "bun",
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      "server/server.ts",
      "--outfile",
      join(resolvedOutDir, target.artifactName),
    ]);
  }
}

async function runCommand(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd: PROJECT_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`command failed (${exitCode}): ${command.join(" ")}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;

  if (command === "validate-targets") {
    assertTargetMetadata();
    return;
  }

  if (command === "validate-manifest") {
    const manifestPath = requireOption(args, "--manifest");
    const manifest = await readFile(manifestPath, "utf8");
    reportValidation(validateChecksumManifest(manifest));
    return;
  }

  if (command === "build") {
    const outDir = resolve(requireOption(args, "--out-dir"));
    const writeChecksumsPath = optionalValue(args, "--write-checksums");
    const verifyAgainstPath = optionalValue(args, "--verify-against");

    assertTargetMetadata();
    await buildReleaseArtifacts(outDir);

    const manifest = await generateChecksumManifest(outDir);
    reportValidation(await validateReleaseDirectory(outDir, manifest));

    if (writeChecksumsPath) {
      const destination = resolve(writeChecksumsPath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, manifest);
      console.log(`wrote ${relative(process.cwd(), destination)}`);
    }

    if (verifyAgainstPath) {
      const expectedManifest = await readFile(resolve(verifyAgainstPath), "utf8");
      if (normalizeManifest(expectedManifest) !== normalizeManifest(manifest)) {
        throw new Error(`${verifyAgainstPath} does not match generated release checksums`);
      }
      console.log(`verified generated checksums against ${verifyAgainstPath}`);
    }

    return;
  }

  throw new Error(`unknown release command: ${command ?? "(missing)"}`);
}

function assertTargetMetadata(): void {
  const names = artifactNames();
  const errors: string[] = [];

  if (new Set(names).size !== names.length) {
    errors.push("release artifact names must be unique");
  }
  if (RELEASE_TARGETS.some((target) => !target.bunTarget.startsWith("bun-"))) {
    errors.push("release targets must use Bun executable target names");
  }

  reportValidation({ ok: errors.length === 0, errors });
}

function reportValidation(result: ValidationResult): void {
  if (result.ok) {
    return;
  }

  throw new Error(result.errors.join("\n"));
}

function requireOption(args: string[], option: string): string {
  const value = optionalValue(args, option);
  if (!value) {
    throw new Error(`missing required option: ${option}`);
  }
  return value;
}

function optionalValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${option}`);
  }
  return value;
}

function normalizeManifest(manifest: string): string {
  return `${manifest.trim().replace(/\r\n/g, "\n")}\n`;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
