# Investigation: Cursor-driven preview highlighting

## Hand-off Brief

1. **What happened.** The user asked whether resting the cursor on a DOT node or edge line highlights the corresponding preview elements and animates the change.
2. **Where the case stands.** Concluded; the cursor-emphasis path and its motion gate are confirmed in source and focused tests.
3. **What's needed next.** No diagnostic work remains; the behavior can be adjusted through `animate` or the cursor-emphasis CSS if desired.

## Case Info

| Field | Value |
| --- | --- |
| Ticket | N/A |
| Date opened | 2026-07-11 |
| Status | Concluded |
| System | interactive-graphviz.nvim repository |
| Evidence sources | README, source code, tests |

## Problem Statement

"when cursor in on a node or edge line, the node or the edge and nodes are highlighted in the proview, and there is an annimation, right?"

## Evidence Inventory

| Source | Status | Notes |
| --- | --- | --- |
| `README.md` | Available | Documents cursor-to-preview behavior and general animation behavior. |
| Lua cursor-sync source | Available | Candidate source path identified at `lua/interactive-graphviz/sync.lua`. |
| Browser preview implementation | Available | Traced through relay, WebSocket dispatch, DOM classes, CSS animation, and pan behavior. |
| Runtime observation | Missing | No live Neovim/browser reproduction performed. |

## Investigation Backlog

| # | Path to Explore | Priority | Status | Notes |
| - | --- | --- | --- | --- |
| 1 | Confirm documented cursor emphasis semantics | High | Done | Stronghold found in `README.md`. |
| 2 | Trace passive emphasis animation | High | Done | `ig-cursor-pulse` is gated by `html.ig-motion`. |
| 3 | Cross-check automated tests | Medium | Done | 89 Lua sync tests and 86 frontend tests pass. |

## Timeline of Events

| Time | Event | Source | Confidence |
| --- | --- | --- | --- |
| 2026-07-11 | Repository documentation located | `README.md` | Confirmed |

## Confirmed Findings

### Finding 1: Cursor lines map to passive preview emphasis

**Evidence:** `README.md:200`

**Detail:** A node line outlines that node. An edge line outlines the edge and both endpoints; chains select the segment under the cursor. The update is debounced, and unrelated lines clear the outline.

### Finding 2: Cursor emphasis pulses when motion is enabled

**Evidence:** `frontend/styles.css:154`

**Detail:** The cursor outline runs `ig-cursor-pulse 1.6s ease-in-out infinite`, changing stroke opacity between 1 and 0.45.

### Finding 3: The same animation gate controls the pulse and automatic pan

**Evidence:** `frontend/style.ts:24`, `frontend/motion.ts:12`, `frontend/render.ts:467`

**Detail:** Motion runs only when `animate = true` and the browser does not report `prefers-reduced-motion: reduce`. An off-screen cursor target is also panned to the viewport center over 250 ms under the same gate; an already-visible target does not pan.

## Deduced Conclusions

### Deduction 1: The user's premise is correct with two qualifications

**Based on:** Findings 1–3.

**Reasoning:** Cursor movement emits a debounced emphasis target; the frontend assigns `ig-cursor` to the matching node or edge plus endpoints; motion-enabled CSS pulses that outline.

**Conclusion:** The cursor-driven highlight is animated by default, but it becomes static when animation is disabled or reduced motion is requested. The 150 ms cursor debounce is a delay before the update, not the pulse duration.

## Hypothesized Paths

### Hypothesis 1: Cursor-driven emphasis is animated

**Status:** Confirmed

**Theory:** Because animation is enabled by default for highlight changes, passive cursor emphasis may fade/tween too.

**Supporting indicators:** `README.md:176` documents animated highlight changes generally.

**Would confirm:** Browser source applies the animation transition to cursor-emphasis state, or a test observes it.

**Would refute:** Browser source explicitly applies passive emphasis instantly or outside the animation system.

**Resolution:** Confirmed by `frontend/styles.css:154-166`, the shared gate in `frontend/style.ts:24-31`, and passing focused tests.

## Missing Evidence

| Gap | Impact | How to Obtain |
| --- | --- | --- |
| Runtime observation | Source and automated tests confirm behavior, but no manual visual observation was performed | Optional browser reproduction. |

## Source Code Trace

| Element | Detail |
| --- | --- |
| Error origin | N/A |
| Trigger | Cursor movement in a watched DOT buffer |
| Condition | `sync.highlight_on_cursor = true` (default) |
| Related files | `lua/interactive-graphviz/sync.lua`, `server/server.ts`, `frontend/ws.ts`, `frontend/main.ts`, `frontend/emphasis.ts`, `frontend/styles.css`, `frontend/style.ts`, `frontend/motion.ts`, `frontend/render.ts`, focused tests |

## Conclusion

**Confidence:** High

The premise is confirmed. With defaults, a node line gives that node a pulsing blue outline; an edge line gives the edge and both endpoint nodes the same pulsing emphasis. The cursor update is debounced by 150 ms, the pulse cycle is 1.6 seconds, and an off-screen target pans into view over 250 ms. `animate = false` or `prefers-reduced-motion: reduce` makes the outline and pan instant/static.

## Recommended Next Steps

### Diagnostic

No fix is indicated. Change `animate` for global motion behavior, or adjust `ig-cursor-pulse` if cursor emphasis needs a different treatment.

## Reproduction Plan

Open a graph preview, rest the cursor on a node line and then an edge line, and observe both selected elements and transition timing with `animate = true` and `false`.

## Side Findings

- Cursor emphasis is intentionally quieter than click highlighting and does not dim unrelated graph elements (`README.md:205`).

## Follow-up: 2026-07-11

### New Evidence

- `lua/interactive-graphviz/sync.lua:539-596` resolves and emits the debounced node/edge target.
- `frontend/emphasis.ts:206-237` assigns `ig-cursor` to the matching node or to an edge and both endpoints.
- `frontend/styles.css:154-166` defines the 1.6-second cursor pulse.
- `frontend/style.ts:24-31` and `frontend/motion.ts:12-23` gate motion on config plus reduced-motion preference.
- `frontend/render.ts:442-475` animates off-screen cursor-follow panning over 250 ms under the same gate.
- Focused verification: 89/89 Lua sync tests and 86/86 frontend DOM/animation tests passed.

### Updated Hypotheses

Hypothesis 1 transitioned from Open to Confirmed.

### Backlog Changes

All source-trace and automated-test items are Done.

### Updated Conclusion

The cursor emphasis is animated by default: the blue outline pulses. It is static when animation is disabled or reduced motion is requested. Off-screen targets additionally pan into view using the shared animation gate.
