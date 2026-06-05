---
created: 2026-06-05T00:17:30+0200
Story Key: 3-3-source-build-fallback-failure-ux-and-health-check
baseline_commit: 5be643beae330c1822e7d0329b4de8a2eef0ae84
---

# Story 3.3: Source-build fallback, failure UX, and health check

Status: review

## Story

As a Neovim user on an uncovered platform,
I want a clear source-build fallback and good diagnostics,
so that I can still get a working server and understand any failure.

## Acceptance Criteria

1. Given no prebuilt binary matches the platform, when `install.resolve_server_cmd()` runs, then it builds the server from source with Bun and returns a runnable compiled server command instead of the Story 3.2 "no prebuilt binary" hard failure.
2. Given source-build fallback starts, when user-visible copy is emitted, then it is loud and explicit: `no prebuilt binary for <platform>; building from source, requires Bun >= 1.3.10`, with the detected platform included.
3. Given Bun is missing or older than the minimum, when fallback is attempted, then install fails fast with clear copy naming Bun as the missing prerequisite and does not attempt download, compile, or spawn.
4. Given Bun is present, when fallback builds from source, then it uses the existing single-file build path (`bun build --compile server/server.ts --outfile <ignored local fallback binary>`) from the repository/plugin root and preserves frontend embedding through `server/static.ts`.
5. Given fallback build fails, when the error is reported, then stderr/stdout are surfaced in concise helpful copy, no partial fallback binary is promoted, and any temp file is cleaned up.
6. Given fallback succeeds, when the server is spawned, then no wrapper process can orphan the real server: `server.lua` still spawns the returned executable directly with stdin open, preserving the EOF/heartbeat no-orphan model.
7. Given `:checkhealth interactive-graphviz` runs, when diagnostics execute, then Lua health checks report Neovim version, installed binary presence, checksum match/mismatch against `checksums.txt`, Bun availability/version for fallback, and localhost port-bind capability.
8. Given the server `/health` endpoint is requested, when the server is running, then it returns JSON diagnostics including `ok`, protocol/version, pid, port, bind address, and session count without writing diagnostics to stdout.
9. Existing supported-platform behavior is preserved: matching prebuilt platforms still verify/download cached release binaries from Story 3.2 and require no runtime Bun, Node, yarn, or system Graphviz.

## Tasks / Subtasks

- [x] Extend installer fallback while preserving Story 3.2 prebuilt behavior (AC: 1-6, 9)
  - [x] Keep `resolve_server_cmd()` as the public contract used by `server.lua`; return a command list only after a binary is verified or source-built.
  - [x] Refactor unsupported-platform detection so the prebuilt path returns structured fallback context instead of throwing before fallback can run.
  - [x] Add Bun discovery/version helpers using list-form `vim.system()`; parse semver numerically and require local `bun --version` >= `1.3.10` unless implementation proves a higher minimum is necessary.
  - [x] Build to a unique temp path under an ignored local directory, verify the output exists, then atomically promote to a fallback binary path.
  - [x] Run build commands from the plugin root; do not depend on current working directory.
  - [x] Ensure failed fallback builds remove temp files and do not overwrite a known-good fallback binary.
- [x] Implement no-orphan-safe source-build process handling (AC: 4, 6)
  - [x] Do not return `{ "bun", "run", "server/server.ts" }` as the runtime server command after fallback; return the compiled fallback executable path.
  - [x] If a wrapper/process-group helper is needed for the build step, confine it to build time and ensure it is killed/cleaned on failure. (No wrapper needed: `bun build --compile` runs as a one-shot synchronous build via `vim.system():wait()`; the returned runtime command is the compiled executable, spawned directly by `server.lua`.)
  - [x] Preserve `server.lua`'s `vim.system(cmd, { stdin = true, ... })` spawn model and EOF heartbeat semantics. (server.lua unchanged; fallback returns a single-element executable command list, same shape as the prebuilt path.)
- [x] Implement user-facing failure UX (AC: 2, 3, 5)
  - [x] Make unsupported-platform fallback copy explicit and discoverable through `vim.notify`/installer error text, not only debug logs.
  - [x] Include platform, required Bun version, command attempted, and concise stdout/stderr when fallback fails.
  - [x] Avoid noisy stack traces for normal missing-prerequisite cases. (Errors raised with `error(msg, 0)` — no Lua position/traceback prefix.)
- [x] Implement Lua `:checkhealth` diagnostics (AC: 7, 9)
  - [x] Replace scaffold-only `lua/interactive-graphviz/health.lua` with real health checks using `vim.health.start/ok/warn/error/info`.
  - [x] Check Neovim >= 0.10.
  - [x] Check committed `checksums.txt` can be found and parsed.
  - [x] Check current mapped prebuilt binary presence and checksum where a prebuilt mapping exists.
  - [x] Check fallback Bun executable and version without requiring Bun for supported prebuilt cache hits.
  - [x] Check localhost port-bind capability using a short-lived loopback probe and release the port.
- [x] Implement server `/health` endpoint (AC: 8)
  - [x] Expand `server/health.ts` beyond scaffold status.
  - [x] Route `GET /health` in `server/server.ts` without interfering with `/` static frontend or WebSocket upgrade.
  - [x] Report pid, port, bind address, protocol/version, and session count from the existing server/session state.
  - [x] Keep stdout reserved for JSON-line protocol only; HTTP health diagnostics must not write to stdout.
- [x] Add focused tests (AC: 1-9)
  - [x] Extend `tests/install_spec.lua` for unsupported platform fallback, missing Bun, old Bun, build failure cleanup, and successful fallback returning compiled executable.
  - [x] Add `tests/health_spec.lua` or equivalent Lua tests for Neovim version, checksum, Bun, and port-bind reporting with stubs.
  - [x] Add/extend `server/server.test.ts` or `server/health.test.ts` for `/health` JSON shape.
  - [x] Keep existing installer tests green, especially cached prebuilt path no-download behavior.

## Dev Notes

### Scope Boundary

Implement only source-build fallback, install failure UX, Lua health checks, and server `/health`.

Do not implement:

- Windows prebuilt release artifacts.
- Signing, notarization, GPG, cosign, or remote checksum trust changes.
- Any system Graphviz/`dot` runtime path.
- Browser render UX changes, export features, or v2 browser interactivity.
- A new package manager/runtime dependency beyond Bun for fallback.

### Current State Of Files To Update

- `lua/interactive-graphviz/install.lua` currently maps Darwin/Linux glibc/musl to six exact prebuilt artifact names, verifies committed `checksums.txt`, downloads from pinned tag `v0.1.0`, promotes under `dist/bin`, chmods, and strips macOS quarantine. Unsupported platforms currently throw `interactive-graphviz: no prebuilt binary for <platform>`. Story 3.3 should convert that unsupported case into fallback, while preserving all fail-closed prebuilt behavior.
- `lua/interactive-graphviz/server.lua` calls `install.resolve_server_cmd()` inside `ensure_started()` and passes the returned list directly to `vim.system()` with `stdin = true`. Preserve this contract. The returned fallback command should be a compiled executable path, not a long-running `bun run` wrapper.
- `lua/interactive-graphviz/health.lua` is scaffold-only and must become the `:checkhealth` implementation.
- `server/health.ts` is scaffold-only (`{ ok: true, version: "scaffold" }`) and is not routed in `server/server.ts`. Add the real endpoint without changing the protocol stdout channel.
- `scripts/release.ts` already defines the frontend build and compiled server release path. Reuse its build shape conceptually; Lua cannot import this TypeScript helper.
- `checksums.txt` is the committed trust root for prebuilt binaries only. Fallback builds are local artifacts and should not mutate this manifest.
- `dist/` is ignored. Store fallback outputs under an ignored path such as `dist/source-build/<platform>/server` or another documented ignored path.

### Architecture Guardrails

- Runtime supported platforms must remain zero-prerequisite: no runtime Node, yarn, Bun, or system Graphviz if a verified prebuilt is available. [Source: `_bmad-output/planning-artifacts/epics.md` "Epic 3"]
- Source-build fallback uses Bun and must be loud and explicit when no prebuilt matches. [Source: `_bmad-output/planning-artifacts/architecture.md` "Distribution, Install & CI"]
- Fallback must not weaken no-orphan guarantees. The final server process must still be supervised by `server.lua` through `vim.system()` stdin EOF and heartbeat. [Source: `_bmad-output/planning-artifacts/architecture.md` "Cross-Cutting Concerns Identified"]
- A compiled fallback executable spawned directly satisfies the wrapper-orphan risk. If implementation instead keeps any runtime wrapper, it must spawn that wrapper in a dedicated process group and prove the real server cannot survive parent death. [Source: `_bmad-output/planning-artifacts/epics.md` "Story 3.3"]
- Health checks must include Neovim version, binary/checksum, Bun availability, and port-bind capability. [Source: `_bmad-output/planning-artifacts/epics.md` "Story 3.3"]
- `/health` is observability only. It must not add browser feature behavior and must not write non-protocol data to stdout. [Source: `_bmad-output/planning-artifacts/epics.md` "Additional Requirements"]

### Previous Story Intelligence

- Story 3.1 established the six release artifact basenames and `bun build --compile` release path. Do not add Windows assets or rename artifacts.
- Story 3.2 intentionally left unsupported platforms as a clear "no prebuilt binary" error. This story owns replacing that terminal error with fallback.
- Story 3.2 review fixed cached binaries so chmod/quarantine preparation runs even on cache hit. Preserve that path.
- Installer path handling must derive from runtime/plugin root, not caller cwd; Story 3.1/3.2 both found cwd assumptions as a real risk.
- Local `busted` may be unavailable; prior stories used focused compatibility runners plus headless Neovim smoke while CI remains the canonical busted gate.

### Latest Technical Information

- Local validation environment has Bun `1.3.10` and Neovim `0.11.2`; set fallback minimum to `Bun >= 1.3.10` unless implementation discovers a stricter executable-build requirement.
- Bun executable targets and `--compile` are already used by `scripts/release.ts` and Story 3.1. Follow that local build shape instead of inventing a second build system.
- Use list-form `vim.system()` for all Lua process calls. Do not introduce shell strings for version checks, builds, or port probes.

### Testing Requirements

- Run `stylua --check .`.
- Run Lua smoke: `nvim --headless -i NONE -u tests/minimal_init.lua -l tests/nvim_smoke.lua -c qa`.
- Run focused installer and health specs. If `busted` is unavailable locally, run a compatibility harness and state that limitation.
- Run `bun test server` for `/health` endpoint coverage.
- Run `bun build frontend/index.html --outdir dist/frontend` if fallback build or `/health` routing touches server/static embedding assumptions.
- Run `git diff --check`.

### Anti-Patterns To Avoid

- Do not require Bun on supported prebuilt cache hits.
- Do not silently fall back; users must know they are source-building and what prerequisite is required.
- Do not run source from `bun run server/server.ts` as the final runtime server command.
- Do not overwrite a verified prebuilt or fallback binary with an unverified/partial temp file.
- Do not mutate `checksums.txt` for local fallback builds.
- Do not add Windows prebuilt support.
- Do not shell out through string commands when list-form `vim.system()` works.
- Do not emit diagnostics on server stdout; stdout is the protocol channel.

## Project Structure Notes

Expected touched files for implementation:

- `lua/interactive-graphviz/install.lua` (UPDATE): structured unsupported-platform fallback, Bun version/build helpers, fallback binary promotion, helpful failure copy.
- `lua/interactive-graphviz/health.lua` (UPDATE): real `:checkhealth` diagnostics.
- `server/health.ts` (UPDATE): real health payload builder.
- `server/server.ts` (UPDATE): `/health` route and session count wiring.
- `tests/install_spec.lua` (UPDATE): fallback install tests.
- `tests/health_spec.lua` (NEW or UPDATE equivalent): Lua health tests.
- `server/server.test.ts` or `server/health.test.ts` (UPDATE/NEW): `/health` tests.
- `_bmad-output/implementation-artifacts/3-3-source-build-fallback-failure-ux-and-health-check.md` (UPDATE during implementation): dev record, file list, completion notes.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (UPDATE during workflow transitions only).

## References

- Epics: `_bmad-output/planning-artifacts/epics.md` "Story 3.3: Source-build fallback, failure UX, and health check"
- PRD: `_bmad-output/planning-artifacts/prds/prd-interactive-graphviz.nvim-2026-06-02/prd.md` "FR-13: Build-from-source fallback"
- PRD addendum: `_bmad-output/planning-artifacts/prds/prd-interactive-graphviz.nvim-2026-06-02/addendum.md` "Architecture addendum"
- Architecture: `_bmad-output/planning-artifacts/architecture.md` "Distribution, Install & CI"; "Source Tree / Module Organization"; "Development Workflow Integration"
- Previous story: `_bmad-output/implementation-artifacts/3-2-prebuilt-binary-install-with-integrity-verification.md`
- Release helper: `scripts/release.ts`

## Dev Agent Record

### Agent Model Used

GPT-5 Codex (story authoring) / Claude Opus 4.8 (implementation)

### Debug Log References

### Implementation Plan

- Convert unsupported prebuilt platform errors into source-build fallback context.
- Build and promote a local compiled fallback binary with Bun, then let `server.lua` spawn that executable directly.
- Replace scaffold Lua/server health code with executable diagnostics and focused tests.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- AC1/AC9: `resolve_server_cmd()` now routes a known-but-uncovered platform into `build_from_source()` and returns the compiled fallback executable; the supported-platform path (`resolve_platform().supported == true`) is unchanged and still verifies/downloads cached prebuilt binaries with no runtime Bun on a cache hit. Also fixed a latent bug from the partial WIP where `resolve_server_cmd` still called the renamed `detect_platform()`.
- AC2: `build_from_source()` emits a loud `vim.notify` warning `no prebuilt binary for <platform>; building from source, requires Bun >= 1.3.10` with the detected platform label before doing anything.
- AC3: `require_bun()` fails fast with copy naming Bun when `bun` is absent, unparseable, or below `1.3.10` — no download/compile/spawn is attempted (verified by tests asserting no `bun build`/`curl` calls).
- AC4: Build uses `bun build --compile server/server.ts --outfile <tmp>` from the plugin root (`cwd = root`, absolute paths), preserving frontend embedding via `server/static.ts` (real local compile bundled 185 modules into a single 67M executable).
- AC5: On build failure, stderr/stdout are surfaced in concise copy, the temp file is removed, and no partial/fallback binary is promoted.
- AC6: No `bun run` wrapper — the returned runtime command is the compiled executable path, spawned directly by the unchanged `server.lua` `vim.system(cmd, { stdin = true })` EOF/heartbeat model.
- AC7: `health.lua` rewritten with real `vim.health` checks: Neovim >= 0.10, checksums.txt found/parsed, mapped prebuilt presence + checksum match/mismatch, Bun availability/version (not required on prebuilt cache hits), and a short-lived loopback TCP port-bind probe that releases the port. New read-only, non-throwing install introspection helpers (`plugin_root`, `inspect_prebuilt`, `inspect_bun`) back the report.
- AC8: `server/health.ts` returns a real payload (`ok`, `protocol`, `version`, `pid`, `port`, `bind`, `sessions`); routed as `GET /health` in `server.ts` via `Response.json(...)` without touching `/` static serving or the WS upgrade, and without writing to the stdout protocol channel.
- Validation: `bun test server` 63 pass / 0 fail (incl. new `server/health.test.ts` unit + live-route tests). `tests/install_spec.lua` 13 pass and `tests/health_spec.lua` 6 pass via a new busted-compatible shim (`tests/support/busted_compat.lua`) run under plain `lua` — busted is NOT installed locally so CI remains the canonical busted gate. `stylua --check .` clean, `git diff --check` clean, headless `nvim` smoke + a real-host `health.check()` run both succeed, `bun build --compile` fallback verified to produce a runnable single-file executable, and `bun run scripts/release.ts validate-targets` still passes (no Windows/dup regressions).

### File List

- lua/interactive-graphviz/install.lua (UPDATE): source-build fallback, Bun version/build helpers, fallback promotion, loud failure UX, read-only health introspection; fixed renamed-function call bug.
- lua/interactive-graphviz/health.lua (UPDATE): real `:checkhealth` diagnostics.
- server/health.ts (UPDATE): real `/health` payload builder.
- server/server.ts (UPDATE): `GET /health` route wired to session count + bind/port.
- tests/install_spec.lua (UPDATE): source-build fallback tests (success, missing/old Bun, build-failure cleanup, no-wrapper, semver).
- tests/health_spec.lua (NEW): Lua `:checkhealth` diagnostics tests.
- tests/support/busted_compat.lua (NEW): busted-free local shim for pure-Lua specs.
- server/health.test.ts (NEW): `/health` JSON-shape unit tests + live-route stdout-isolation test.

### Change Log

- 2026-06-05: Implemented source-build fallback, install failure UX, Lua `:checkhealth` diagnostics, and server `/health` endpoint; added focused Lua + TS tests and a busted-free local test shim. Story moved in-progress → review.
