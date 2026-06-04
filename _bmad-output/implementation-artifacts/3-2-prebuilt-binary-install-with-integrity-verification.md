---
created: 2026-06-04T23:58:33+0200
Story Key: 3-2-prebuilt-binary-install-with-integrity-verification
baseline_commit: 1b60a60c76c8685a9c5d2a33d31c7f1c4ce70f80
---

# Story 3.2: Prebuilt binary install with integrity verification

Status: done

## Story

As a Neovim user on a supported platform,
I want the plugin to fetch and verify the right prebuilt binary on install,
so that it just works with zero prerequisites and a tampered/corrupt download is refused.

## Acceptance Criteria

1. Given a supported platform, when the server command is resolved for install/runtime, then `lua/interactive-graphviz/install.lua` detects OS, architecture, and Linux libc and maps to the exact Story 3.1 artifact names: `server-linux-x64`, `server-linux-arm64`, `server-linux-x64-musl`, `server-linux-arm64-musl`, `server-darwin-x64`, `server-darwin-arm64`.
2. Given a mapped artifact, when the binary is absent or fails checksum verification, then the installer downloads the tag-pinned GitHub Release asset to a temp path, verifies it against the committed root `checksums.txt`, atomically renames it into the plugin-local binary path, and applies executable mode before returning a spawn command.
3. Given an existing installed binary, when its SHA-256 matches the committed manifest entry for the mapped artifact, then no network download or runtime Bun/Node/yarn command is required.
4. Given a checksum mismatch, malformed manifest, truncated download, failed atomic rename, or unsupported/missing download tool, when install verification runs, then the binary is not run, the temp file is not promoted, and the failure message is explicit enough for users to understand what failed.
5. Given macOS, when a downloaded binary is verified and promoted, then `com.apple.quarantine` is stripped when `xattr` is available; if stripping fails, report a warning or clear error before spawn rather than silently hiding the problem.
6. Given an unsupported platform or missing matching artifact, when `resolve_server_cmd()` runs, then this story does not silently fall back to source build; it returns a clear "no prebuilt binary for <platform>" error and leaves Bun source-build fallback to Story 3.3.
7. Existing preview lifecycle behavior is preserved: `server.lua` still calls `install.resolve_server_cmd()`, still spawns via `vim.system()` with stdin open, and still relies on the same EOF/heartbeat no-orphan model.

## Tasks / Subtasks

- [x] Expand `install.lua` from dev-source resolver to verified prebuilt resolver (AC: 1-4, 6)
  - [x] Keep `resolve_server_cmd()` as the public contract used by `server.lua`; return `{ binary_path }` only after verification passes.
  - [x] Add internal helpers for project/runtime path resolution, manifest parsing, artifact mapping, checksum calculation, temp download, atomic promotion, chmod, and cleanup.
  - [x] Parse root `checksums.txt` with strict `<sha256>  <artifact-name>` lines; reject duplicates, missing mapped artifact, malformed SHA, and unexpected empty manifests.
  - [x] Use `vim.fn.sha256(binary_bytes)` for digest calculation and binary-mode reads; do not shell out to `sha256sum`/`shasum`.
  - [x] Detect platform with `uname -s` and `uname -m`; map `Darwin` + `x86_64`/`arm64` and `Linux` + `x86_64`/`amd64`/`aarch64`/`arm64`.
  - [x] Detect Linux libc so Alpine/dev-containers select `*-musl`; glibc Linux selects non-musl artifacts.
  - [x] Unsupported OS/arch/libc combinations must return a structured clear error, not a best-effort wrong artifact.
- [x] Implement tag-pinned download and promotion (AC: 2-5)
  - [x] Add one explicit release trust root in `install.lua`, e.g. `GITHUB_REPO = "xuyangy/interactive-graphviz.nvim"` and `RELEASE_TAG = "<pinned v-tag>"`; never use `latest`.
  - [x] Construct asset URL as `https://github.com/xuyangy/interactive-graphviz.nvim/releases/download/<tag>/<artifact>`.
  - [x] Download to a unique temp path from `vim.fn.tempname()`; prefer `curl -fL --retry 3 --output <tmp> <url>` with `wget -O <tmp> <url>` fallback if desired.
  - [x] Verify temp checksum before promotion; only then use `vim.uv.fs_rename(tmp, final)` or equivalent atomic rename within the same filesystem.
  - [x] Apply executable mode with `vim.uv.fs_chmod(final, 493)` (`0755`) after promotion.
  - [x] On macOS, run `xattr -d com.apple.quarantine <final>` when `xattr` exists; tolerate absent attribute but surface real command errors.
  - [x] Ensure failed downloads and failed verification remove temp files and never overwrite a known-good installed binary.
- [x] Choose and document the binary install location (AC: 2-3)
  - [x] Store verified binaries in a plugin-local ignored path such as `dist/bin/<artifact>` or another documented path under this repo/runtime root.
  - [x] Do not commit downloaded binaries; confirm `.gitignore` keeps the install output ignored.
  - [x] Preserve root `checksums.txt` as the committed source of trust.
- [x] Add focused Lua tests for installer behavior (AC: 1-6)
  - [x] Add `tests/install_spec.lua` using plain busted-compatible stubs for `vim.fn`, `vim.uv`, and `vim.system` where practical.
  - [x] Test artifact mapping for Darwin x64/arm64, Linux glibc x64/arm64, Linux musl x64/arm64, and unsupported Windows/BSD.
  - [x] Test manifest parsing rejects malformed lines, duplicate artifacts, missing current artifact, and checksum mismatch.
  - [x] Test cache hit returns the verified binary path without invoking download.
  - [x] Test corrupt/truncated download does not promote temp path and does not return a runnable command.
  - [x] Test macOS quarantine strip invocation after successful promotion.
  - [x] Keep existing `server.lua` tests/smoke green; if they stub `install.resolve_server_cmd()`, preserve that seam.
- [x] Add minimal documentation or inline completion notes for implementation handoff (AC: 2, 4, 6)
  - [x] Document the pinned release tag and how it relates to committed `checksums.txt`.
  - [x] Document that source-build fallback remains Story 3.3 and must not be quietly implemented here.

### Review Findings

- [x] [Review][Patch] Verified cache hit skipped executable/quarantine preparation [lua/interactive-graphviz/install.lua:285]

## Dev Notes

### Scope Boundary

This story implements prebuilt binary resolution and integrity verification only. Do not implement:

- Bun source-build fallback, fallback process-group handling, or fallback UX; that is Story 3.3.
- `:checkhealth` binary/checksum/Bun/port diagnostics; health stays scaffolded until Story 3.3 unless a small helper is needed and tested.
- Release workflow changes beyond narrow compatibility fixes; Story 3.1 already completed release targets and committed `checksums.txt`.
- Windows prebuilt support.
- Signing, notarization, GPG, or cosign.
- Runtime protocol, browser rendering, session lifecycle, or layout-engine behavior.

### Current State Of Files To Update

- `lua/interactive-graphviz/install.lua` currently resolves `server/server.ts` from runtimepath and returns `{ "bun", "run", server_entry }`. Replace the body with verified prebuilt resolution while keeping the function name and return contract stable.
- `lua/interactive-graphviz/server.lua` calls `install.resolve_server_cmd()` inside `ensure_started()` and passes the returned list directly to `vim.system()`. Preserve that integration and its stdin/EOF heartbeat model.
- `lua/interactive-graphviz/health.lua` is scaffold-only. Do not make full health behavior part of this story.
- `checksums.txt` exists at repo root with deterministic SHA-256 lines for the six Story 3.1 artifact basenames. Treat it as the trusted local manifest.
- `.gitignore` already ignores `dist/`; if the verified binary path is under `dist/`, no new ignore rule should be required.
- `scripts/release.ts` exports the release target names and manifest format in TypeScript for CI. Do not import TypeScript into Lua; mirror the exact artifact names in tests.

### Architecture Guardrails

- Integrity is fail-closed: download to temp, verify SHA-256, atomic rename, then `chmod +x`; checksum mismatch refuses to run and reports clearly. [Source: `_bmad-output/planning-artifacts/architecture.md` "Distribution, Install & CI"]
- Checksums are committed in-source and pinned to a release tag; do not fetch a remote checksum manifest beside the artifact as the trust root. [Source: `_bmad-output/planning-artifacts/architecture.md` "Distribution, Install & CI"]
- Platform detection must include Linux libc selection for glibc vs musl. [Source: `_bmad-output/planning-artifacts/architecture.md` "Distribution, Install & CI"]
- macOS downloads must strip `com.apple.quarantine` to avoid spawn failures. [Source: `_bmad-output/planning-artifacts/architecture.md` "Distribution, Install & CI"]
- No Windows prebuilt in v1; uncovered platforms are handled by source-build fallback in Story 3.3. [Source: `_bmad-output/planning-artifacts/prds/prd-interactive-graphviz.nvim-2026-06-02/prd.md` "No Windows prebuilt binary in v1"]
- Runtime users must not need Node, yarn, Bun, or system Graphviz when a supported prebuilt is available. [Source: `_bmad-output/planning-artifacts/epics.md` "Story 3.2"]

### Previous Story Intelligence

- Story 3.1 produced the six exact artifact basenames and root manifest format that this story must consume: `<sha256>  <artifact-name>`.
- Story 3.1 resolved the in-source checksum tension by adding a pre-tag manifest-preparation path and a tag workflow that verifies generated checksums against committed `checksums.txt`; Story 3.2 must therefore trust committed `checksums.txt`, not a mutable remote manifest.
- Story 3.1 explicitly deferred installer platform detection, download, verification, atomic rename, chmod, and macOS quarantine stripping to this story.
- Recent review fixed release helper path resolution from caller cwd to repo root. Installer path handling should likewise avoid caller-cwd assumptions; derive paths from runtime/plugin root.

### Latest Technical Information

- Neovim current Lua docs confirm `vim.system({cmd}, opts, on_exit)` runs commands without a shell, throws when the command cannot run, and `SystemObj:write(nil)` closes stdin. Keep `server.lua` using list-form commands and do not introduce shell strings. [Source: https://neovim.io/doc/user/lua.html `vim.system()`]
- Local Neovim exposes `vim.fn.sha256`, `vim.uv.fs_rename`, and `vim.uv.fs_chmod`; use these instead of external hash/chmod tools where possible.
- GitHub docs document release asset download links under repository releases. This story must use the tag-specific `/releases/download/<tag>/<asset>` form, not `/releases/latest/...`. [Source: https://docs.github.com/articles/linking-to-releases]

### Testing Requirements

- Run `stylua --check .`.
- Run Lua smoke with `nvim --headless -i NONE -u tests/minimal_init.lua -l tests/nvim_smoke.lua -c qa`.
- Run focused Lua installer tests, preferably `busted tests/install_spec.lua`; if local `busted` is unavailable, note it and ensure CI still covers it.
- Run existing Lua specs that could be affected by the installer seam: `tests/scaffold_spec.lua`, `tests/config_spec.lua`, `tests/commands_spec.lua`, and any server lifecycle specs that stub `resolve_server_cmd()`.
- Run `bun test server` only if implementation changes shared release/build files or if a regression check is cheap.

### Anti-Patterns To Avoid

- Do not return `{ "bun", "run", "server/server.ts" }` on supported platforms after this story.
- Do not run a downloaded binary before checksum verification.
- Do not overwrite a known-good installed binary with an unverified temp file.
- Do not parse `checksums.txt` with substring matching that can accept the wrong artifact.
- Do not use `latest` as a release URL or trust root.
- Do not choose a Linux glibc artifact for musl systems.
- Do not add Windows assets or "best effort" unsupported-platform downloads.
- Do not make the implementation depend on the current working directory.

## Project Structure Notes

Expected touched files for implementation:

- `lua/interactive-graphviz/install.lua` (UPDATE): platform/libc detection, manifest parsing, verified download, atomic promotion, executable mode, macOS quarantine strip, stable `resolve_server_cmd()`.
- `tests/install_spec.lua` (NEW): installer unit tests with stubs and temp fixtures.
- `.gitignore` (UPDATE, possible): only if verified binary storage is not already ignored.
- `README.md` or `doc/interactive-graphviz.txt` (UPDATE, optional): only for a concise note about pinned prebuilt install behavior if implementation needs user-visible copy.
- `_bmad-output/implementation-artifacts/3-2-prebuilt-binary-install-with-integrity-verification.md` (UPDATE during implementation): dev record, file list, completion notes.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (UPDATE during workflow transitions only).

## References

- Epics: `_bmad-output/planning-artifacts/epics.md` "Story 3.2: Prebuilt binary install with integrity verification"
- PRD: `_bmad-output/planning-artifacts/prds/prd-interactive-graphviz.nvim-2026-06-02/prd.md` "FR-12: Prebuilt binary install"; "No Windows prebuilt binary in v1"
- PRD addendum: `_bmad-output/planning-artifacts/prds/prd-interactive-graphviz.nvim-2026-06-02/addendum.md` "Distribution / supply-chain notes"
- Architecture: `_bmad-output/planning-artifacts/architecture.md` "Distribution, Install & CI"; "Project Structure & Boundaries"; "Development Workflow Integration"
- Previous story: `_bmad-output/implementation-artifacts/3-1-cross-compiled-release-pipeline-with-checksums.md`
- Neovim Lua docs: https://neovim.io/doc/user/lua.html
- GitHub release links: https://docs.github.com/articles/linking-to-releases

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Debug Log References

- 2026-06-05T00:02:42+0200: `busted tests/install_spec.lua` unavailable locally (`command not found`); added and exercised tests with a Lua compatibility runner.
- 2026-06-05T00:07:38+0200: Validation passed: `stylua --check .`, `nvim --headless -i NONE -u tests/minimal_init.lua -l tests/nvim_smoke.lua -c qa`, `bun test server`, installer spec compatibility runner, Lua syntax load, `git diff --check`.
- 2026-06-05T00:13:50+0200: Review patch applied for cached binary chmod/quarantine preparation; validations rerun green except local `busted` remains unavailable.

### Implementation Plan

- Replace Bun source resolution with fail-closed prebuilt resolution based on runtime-root `checksums.txt`.
- Keep downloaded binaries under ignored `dist/bin/<artifact>` and only return the binary command after checksum verification, atomic promotion, chmod, and macOS quarantine handling.
- Pin downloads to `v0.1.0` GitHub Release assets and leave source-build fallback to Story 3.3.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Implemented verified prebuilt resolver for Darwin/Linux glibc/Linux musl artifact mapping.
- Added strict committed manifest parsing, SHA-256 verification via `vim.fn.sha256`, temp download, atomic promotion, chmod, cleanup, and macOS quarantine stripping.
- Added focused busted-compatible installer tests for mapping, manifest failures, cache hit, corrupt download refusal, promotion/chmod, and quarantine strip.
- Documented pinned release tag `v0.1.0`; source-build fallback remains explicitly deferred to Story 3.3.
- Review fixed cached verified binaries so chmod and macOS quarantine handling are retried before returning a spawn command.

### File List
- `_bmad-output/implementation-artifacts/3-2-prebuilt-binary-install-with-integrity-verification.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `lua/interactive-graphviz/install.lua`
- `tests/install_spec.lua`

### Change Log

- 2026-06-05T00:07:38+0200: Completed Story 3.2 implementation and marked ready for review.
