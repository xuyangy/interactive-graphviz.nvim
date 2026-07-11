---
title: 'Attention-grabbing cursor emphasis bloom'
type: 'feature'
created: '2026-07-11'
status: 'done'
baseline_commit: 'aed57b64c08e6aaa2bcd09c5f9698132feb152fb'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The current continuous stroke-opacity pulse is too subtle to reliably draw attention to the node or edge corresponding to the Neovim cursor.

**Approach:** Replace it with a stronger continuous cyan glow that repeatedly blooms outward and contracts inward for as long as the cursor remains on the target. A cursor on an edge animates the edge and both endpoint nodes together; this should evoke the supplied reference without reproducing its more complex staged path animation.

## Boundaries & Constraints

**Always:** Preserve the existing `ig-cursor` selection semantics, cyan visual identity, click/search precedence, edge endpoint matching, multi-edge behavior, pan-to-target behavior, last-wins clearing, and post-render reapplication. Keep cursor emphasis additive: it may change stroke, stroke width, stroke opacity, and glow/filter, but must never change group/element opacity or dim unrelated graph elements. The glow cycle must remain active for the entire time the cursor target is emphasized, stop immediately when emphasis clears or moves, and begin cleanly on the new target. Gate all motion through the existing `animate` plus `prefers-reduced-motion` decision; the disabled path applies a strong static glow.

**Ask First:** Changing the cyan hue, adding user-facing animation configuration, changing the 150 ms cursor debounce, or introducing directional/staggered edge propagation.

**Never:** Add protocol/server changes, JavaScript timers, cloned SVG paths, staged/directional path propagation, new dependencies, or changes to which graph elements cursor synchronization selects.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Node line | Emphasize a live node with motion enabled | Node repeatedly glows outward and inward until emphasis clears | N/A |
| Edge line | Emphasize a live edge key | Every matching edge plus both live endpoints glow together continuously; first edge remains the pan target | N/A |
| Rapid target change | A new emphasize frame arrives during a glow cycle | Old animation stops immediately; new target starts its own glow cycle with no trail | N/A |
| Resting cursor | No new frame arrives while the target stays emphasized | Glow continues cycling without requiring messages or timers | N/A |
| Clear or stale key | `null` or no live match | All cursor emphasis clears and any cursor pan is cancelled | Graceful no-op |
| Motion disabled | `animate=false` or reduced-motion requested | Strong static outline/glow appears instantly with no cycling | N/A |
| Click/search overlap | Target also has selected, neighbor, or dimmed state | Existing click/search stroke precedence and dim state remain authoritative | N/A |

</frozen-after-approval>

## Code Map

- `frontend/emphasis.ts` -- resolves cursor targets, manages `ig-cursor`, and invokes pan/cancel hooks.
- `frontend/styles.css` -- owns the current cursor outline and subtle repeating pulse under `html.ig-motion`.
- `frontend/style.ts` and `frontend/motion.ts` -- synchronize the shared animation/reduced-motion gate.
- `frontend/render.dom.test.ts` -- cursor DOM behavior and injected stylesheet regression coverage.
- `README.md` and `doc/interactive-graphviz.txt` -- user-facing cursor emphasis and animation behavior.

## Tasks & Acceptance

**Execution:**
- [x] `frontend/styles.css` -- replace the subtle opacity pulse with a conspicuous motion-gated repeating glow-out/glow-in cycle and strong static fallback; retain existing precedence selectors and stroke-only semantics.
- [x] `frontend/emphasis.ts` -- preserve immediate removal/reapplication semantics so old targets stop and new targets begin cleanly without timers or stale classes.
- [x] `frontend/style.ts` -- update cursor-motion comments to describe the stronger repeating glow.
- [x] `frontend/render.dom.test.ts` -- cover the repeating glow CSS, static disabled-motion behavior, and all existing node/edge/clear/precedence invariants.
- [x] `README.md` and `doc/interactive-graphviz.txt` -- describe the attention bloom, steady fallback, and motion gate accurately.

**Acceptance Criteria:**
- Given cursor emphasis with motion enabled, when a live node or edge target remains active, then every selected cursor target repeatedly glows outward and inward without dimming unrelated elements.
- Given emphasis changes during a glow cycle, when the new target is applied, then the old animation stops immediately and the new target begins glowing with no trail.
- Given animation is disabled or reduced motion is requested, when cursor emphasis is applied, then the identical final target set appears immediately with a strong static glow and no cycling.
- Given the full frontend test suite, when the change is verified, then cursor selection, edge endpoints, multi-edges, rerender survival, click/search precedence, pan behavior, and animation gating remain green.

## Spec Change Log

## Design Notes

CSS remains the animation engine, so the glow continues without additional WebSocket frames, JavaScript timers, or DOM churn. The existing `ig-cursor` class lifecycle starts the infinite motion-gated cycle and removing that class stops it; reduced-motion and `animate=false` retain only the strong static base style.

## Verification

**Commands:**
- `bun test frontend/render.dom.test.ts frontend/animate.test.ts` from `frontend/` -- expected: all focused DOM and motion tests pass.
- `bun test` from `frontend/` -- expected: full frontend suite passes.
- `bun build index.html --outdir /tmp/interactive-graphviz-frontend-build` from `frontend/` -- expected: production bundle builds successfully.

**Manual checks:**
- In a live preview, move between a node line, an edge line, a shared-endpoint edge, and a blank line; confirm a conspicuous repeating glow-out/glow-in cycle, immediate target changes, and clean clearing.

## Suggested Review Order

**Glow design**

- Strong static cyan treatment provides the accessible, non-animated final state.
  [`styles.css:134`](../../frontend/styles.css#L134)

- One filter keyframe drives the continuous outward-and-inward bloom.
  [`styles.css:168`](../../frontend/styles.css#L168)

- Motion-scoped selectors keep disabled and reduced-motion paths static.
  [`styles.css:182`](../../frontend/styles.css#L182)

**Behavior contracts**

- DOM regression asserts repeating motion without element-opacity changes.
  [`render.dom.test.ts:763`](../../frontend/render.dom.test.ts#L763)

- Disabled animation preserves the identical edge-and-endpoint target set.
  [`render.dom.test.ts:780`](../../frontend/render.dom.test.ts#L780)

**User-facing behavior**

- README explains the continuous bloom and static fallback.
  [`README.md:176`](../../README.md#L176)

- Vim help documents cursor glow behavior alongside its configuration gate.
  [`interactive-graphviz.txt:94`](../../doc/interactive-graphviz.txt#L94)

**Follow-up boundaries**

- Pre-existing reduced-motion refresh and shape-coverage gaps remain explicitly deferred.
  [`deferred-work.md:11`](deferred-work.md#L11)
