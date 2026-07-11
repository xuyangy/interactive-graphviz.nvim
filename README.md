# interactive-graphviz-preview.nvim

Live Graphviz/DOT preview for Neovim — edit a `.dot`/`.gv` buffer and see it
render in your browser, updating as you type. Rendering happens in the browser
via bundled Graphviz-WASM, so there is **no system Graphviz and no Node/yarn at
runtime** on supported platforms.

```
:GraphvizPreview      " open the current DOT buffer in the browser
```

## Features

- Command-started preview with a clean lifecycle (start / stop / toggle).
- Live reload on buffer change (debounced ~200 ms, latest-wins).
- Last good render is preserved and a visible error is shown on a bad graph.
- Interactive preview: zoom/pan with view preservation across reloads,
  click-to-highlight neighbors, live search (`/`), animated transitions.
- Editor↔graph sync, both directions: click a node to jump to its source
  line; the node under your cursor gets an attention-grabbing cyan glow in the
  preview — on an edge line, the edge and both endpoint nodes light up.
- Dark mode: the preview follows your OS/browser color scheme
  (`prefers-color-scheme`) — canvas, toolbar, search box, and notices theme
  together, and Graphviz's default black-on-white graph colors are remapped
  in dark mode while non-default colors you set in DOT (`color=`,
  `fontcolor=`, `bgcolor=`) are left exactly as written. (An explicit
  `color=black` or `bgcolor=white` is indistinguishable from the default in
  the SVG output, so it is remapped like the default.)
- `dot` and `neato` layout engines, switchable at runtime.
- Zero-prerequisite install on supported platforms: a verified prebuilt binary
  is fetched automatically; uncovered platforms fall back to a source build.
- `:checkhealth interactive-graphviz` diagnostics.
- Loopback-only by default; LAN exposure is explicit opt-in.

## Requirements

- **Neovim ≥ 0.10**
- `curl` or `wget` (used once, to fetch the prebuilt binary)
- A browser (opened via `vim.ui.open`, or a command you configure)
- Only for the source-build fallback on uncovered platforms: **Bun ≥ 1.3.10**

No system Graphviz, Node, or yarn are required at runtime on supported platforms.

## Installation

[lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "xuyangy/interactive-graphviz-preview.nvim",
  ft = { "dot" },
  opts = {}, -- calls require("interactive-graphviz").setup{}; zero-config works
}
```

[packer.nvim](https://github.com/wbthomason/packer.nvim):

```lua
use({
  "xuyangy/interactive-graphviz-preview.nvim",
  config = function()
    require("interactive-graphviz").setup({})
  end,
})
```

`setup{}` is optional — commands and defaults work without it. The first time a
preview starts, the plugin downloads the prebuilt server binary for your
platform, verifies its SHA-256 against the in-source `checksums.txt`, and caches
it under the plugin's ignored `dist/bin/`. Subsequent starts reuse the cached,
verified binary with no network access.

## Usage

Open a DOT/GV file (`filetype=dot`) and run:

| Command | Description |
| --- | --- |
| `:GraphvizPreview` | Start the preview for the current buffer and open it in the browser. |
| `:GraphvizPreviewStop` | Stop the current buffer's preview. Idempotent; shuts the server down when it was the last session. |
| `:GraphvizPreviewToggle` | Start if stopped, stop if running. |
| `:GraphvizEngine [engine]` | With no argument, report the current and available engines. With an argument (e.g. `:GraphvizEngine neato`), switch the layout engine and re-render. |
| `:GraphvizUrl` | Print the current buffer's full preview URL into `:messages` history. Useful when the startup notification was truncated or swallowed by a notification UI (noice.nvim, nvim-notify, …) — the echoed URL stays retrievable via `:messages`. Requires an active preview. Note the URL contains the session's auth token (loopback-scoped, dies with the server). |

Edits to the buffer re-render automatically (debounced, latest-wins). On a bad
graph the last good render is kept and an error is shown rather than blanking
the preview.

### Navigating the graph (in the browser)

The preview is interactive — navigate large graphs without leaving Neovim:

| Gesture | Action |
| --- | --- |
| Scroll wheel | Zoom in / out |
| Double-click | Zoom in |
| Shift + double-click | Zoom out |
| Click + drag | Pan |
| `p` | Toggle pan-scroll mode: the wheel pans instead of zooming — scroll up/down, Shift + scroll left/right (trackpads pan both axes). Double-click and the toolbar magnifiers still zoom |
| `0` or `r` | Reset the view to fit the viewport |
| `Shift+F` | Fit the whole graph into the current window — recomputed from the live window size, so use this after resizing the browser window |
| `f` | Fit the view to the current highlight (click selection + neighbors, or search matches); with nothing highlighted, same as `Shift+F` |
| Toolbar (top-right) | Click the home icon to reset the view, the corner-brackets icon to fit the graph to the window, the +/- magnifiers to zoom, the four-way-arrows icon to toggle pan-scroll mode (lit orange while on) — button equivalents of the gestures above |
| Toolbar download button | Save the graph as `graph.svg` — exported as currently rendered (including zoom/pan; press `0` first for the full graph), with any click/cursor emphasis stripped |
| Toolbar HTML-export button | Save a self-contained interactive `graph.html` (~1 MB) — opens offline with zoom/pan, click-highlight, `/` search, and the SVG export all working. Re-renders the graph fresh when opened; Neovim-linked features (jump-on-click, cursor echo) are inert. Safe to share: the file carries your interactivity config but never the preview session's auth token |
| Click a node | Highlight it and its neighbors; dim the rest. Also moves the Neovim cursor to the node's source line (when `sync.jump_on_click`) |
| Shift + click | Add another node to the highlight (multi-select) |
| Alt + click | Also highlight the whole cluster the node lives in |
| `/` | Open the live-search box (type to filter nodes / edges) |
| `Esc` | Close search if open, otherwise clear all highlighting |
| Click empty canvas | Clear all highlighting |

When `preserve_view = true` (the default), your current zoom/pan is kept across
live-reload re-renders, so editing the buffer no longer snaps you back to the
top of the graph. Set `preserve_view = false` to reset to fit on every reload.

If the connection to Neovim drops (server restart, network blip), the preview
shows "Disconnected — reconnecting…" and reconnects automatically. A tab whose
session can no longer be resumed (its server is gone for good) says "Session
expired — reopen the preview from Neovim" instead of retrying forever.

### Highlighting neighbors

Click any node to trace its relationships: the clicked node and its neighbors
are emphasized while everything else dims. Which neighbors light up follows the
`highlight_mode` config key (`setup{ highlight_mode = "..." }`):

| `highlight_mode` | Highlights |
| --- | --- |
| `single` | Just the clicked node (no neighbors) |
| `upstream` | Predecessors (incoming-edge sources) + the connecting edges |
| `downstream` | Successors (outgoing-edge targets) + the connecting edges |
| `bidirectional` (default) | Both directions |

Shift + click adds more nodes to the highlight set, Alt + click also lights up
the whole cluster a node belongs to, and `Esc` (or a click on the empty canvas)
clears everything back to full opacity. Subgraph (cluster) boxes follow their
contents: a box and its title dim together with its member nodes, and stay at
full opacity while any *direct* member is highlighted. Both cluster forms work
— `cluster`-prefixed names and `cluster=true` subgraphs — with two
limitations: an *anonymous* `{ cluster=true; … }` box always dims as
background (its rendered name is graphviz-internal and can't be matched), and
a nested parent cluster dims when its only highlighted content sits inside a
child cluster (membership is innermost-only, the same rule Alt+click cluster
highlighting uses). Highlighting survives live-reload: it is
re-applied to the new render as long as the selected nodes still exist.

Press `f` to zoom and pan the view to frame the highlighted set — handy after
selecting a node in a large graph, or while a search owns the highlight. With
nothing highlighted, `f` fits the whole graph like `Shift+F`.

### Searching

Press `/` to open a compact search box. Type a query and matching nodes/edges
are emphasized live while non-matches dim — the same highlight/dim treatment as
click-highlight. A result counter shows the match count as `N/total` (matches
over the searchable elements in the active scope, e.g. `3/12`); an empty query
or zero matches reads `0/total` and dims nothing.

Toggles in the search box refine matching:

| Toggle | Effect |
| --- | --- |
| `Aa` (case-sensitive) | Off (default) = case-insensitive substring; on = exact-case substring |
| `.*` (regex) | Treat the query as a regular expression (an invalid pattern reads `invalid regex` and matches nothing instead of crashing) |
| Scope (`both` / `nodes` / `edges`) | Restrict matching to nodes only, edges only, or both (default) |

The toggles' initial state comes from the `search` config key
(`setup{ search = { scope = ..., case_sensitive = ..., regex = ... } }`); you
can still flip them per-session in the box.

Press `Esc` to close the search box and clear its highlight, returning every
element to full opacity. Search highlighting survives live-reload: while the box
is open, the query is re-applied against each new render.

### Animation

Re-renders and highlight changes animate by default for legibility: when the
graph re-renders on live-reload, node and edge positions tween rather than snap,
and when the highlight set changes (click, search, clear) the emphasis fades in
and out. Cursor emphasis continuously blooms outward and contracts inward for
as long as its target remains active. Animation never blocks interaction — the
latest render always wins and transitions stay short and interruptible.

Animation can be turned off with `setup{ animate = false }`, and it always
honors your system's reduced-motion preference: if your OS requests
`prefers-reduced-motion: reduce`, transitions are skipped and changes apply
instantly regardless of the config. The non-animated instant path is the exact
same end result, just without the tween; cursor emphasis remains a strong,
steady cyan outline and glow instead of cycling.

### Editor↔graph sync

The preview and the DOT buffer stay linked in both directions:

- **Graph → editor** (gated by `sync.jump_on_click`, default on): click a node
  in the preview and the Neovim cursor jumps to the node's first occurrence in
  the source buffer. Degradation is graceful: if the clicked node no longer
  exists in the buffer (the browser can be a beat behind your edits), or the
  buffer isn't displayed in any window, you get an informative notification
  instead of a wrong jump.
- **Editor → graph** (gated by `sync.highlight_on_cursor`, default on): rest
  the cursor on a node's line and that node gets a conspicuous cyan glow bloom
  in the preview, debounced by `sync.cursor_debounce_ms`. On an edge line
  (`a -> b`), any cursor position glows the edge **and both endpoint nodes**;
  chains (`a -> b -> c`) light the segment under the cursor. Moving to a line
  with no node or edge clears the glow. Click/search stroke precedence remains
  authoritative: cursor emphasis never dims the rest of the graph and never
  fights an active selection. With animation disabled or reduced motion
  requested, the same targets keep a strong steady glow. In a large graph, if
  the target is outside the visible area the view pans to center it (zoom level
  untouched); a target already on screen never moves the view, so panning
  around by hand is respected.
  Constructs the matcher can't resolve to one edge (ports like `a:p -> b`,
  subgraph endpoints like `{a b} -> c`) fall back to single-node outlining.

One caveat, by design: on a click-jump, **OS window focus stays in the
browser** — the cursor moves, but the plugin never raises or focuses the
Neovim window. Which window your keystrokes land in is window-manager
territory, out of scope.

## Configuration

Defaults shown; pass any subset to `setup{}`:

```lua
require("interactive-graphviz").setup({
  engine = "dot",            -- default layout engine; must be in `engines`
  engines = { "dot", "neato" }, -- selectable engines
  debounce_ms = 200,         -- live-reload debounce (ms), > 0
  port = 0,                  -- listen port; 0 = ephemeral (OS-assigned)
  expose_to_lan = false,     -- false = bind 127.0.0.1; true = bind 0.0.0.0 (see Security)
  open_cmd = nil,            -- nil = vim.ui.open; or a command string, e.g. "firefox"
  preserve_view = true,      -- keep zoom/pan across live-reload re-renders (false = reset to fit)
  highlight_mode = "bidirectional", -- click-highlight direction: single | upstream | downstream | bidirectional
  animate = true,            -- animate re-renders + highlight changes (false = always instant)
  search = {                 -- initial state of the live-search (`/`) box
    scope = "both",          -- both | nodes | edges
    case_sensitive = false,  -- start with the Aa toggle on
    regex = false,           -- start with the .* toggle on
  },
  sync = {                   -- editor↔graph sync (see "Editor↔graph sync")
    jump_on_click = true,    -- clicking a node moves the Neovim cursor to its source line
    highlight_on_cursor = true, -- cursor on a node/edge line outlines it in the preview
    cursor_debounce_ms = 150,   -- cursor-sync debounce (ms), > 0
  },
  heartbeat_ms = 2000,       -- supervision heartbeat interval (ms), > 0
  log_level = "warn",        -- off | error | warn | info | debug
})
```

Invalid values are rejected with a warning and fall back to the default rather
than failing setup. Unknown keys — including typos in `search`/`sync` subfields,
like `case_sensitve` — warn naming the offending key and are ignored. Note that
`bind` is **not** a user-settable key — the bind address is controlled
exclusively by `expose_to_lan` (see Security).

The interactivity keys (`preserve_view`, `highlight_mode`, `animate`,
`search`, `sync.jump_on_click`) apply to open previews **live**: re-running
`setup{}` pushes them to every open preview over the existing connection — no
reopen needed — and a reloaded tab also comes back under the latest pushed
config. (They still ride the preview URL too, so a preview opened later starts
with the same values.) Server-level keys (`port`, `expose_to_lan`,
`heartbeat_ms`) still take effect on the next server start.

The sync keys split across that line: `sync.jump_on_click` is one of the
live-pushed interactivity keys above (a `setup()` re-run applies it to open
previews immediately), while `sync.highlight_on_cursor` and
`sync.cursor_debounce_ms` are read on the Neovim side — a `setup()` change
applies from the next cursor movement, no re-open needed. One nuance when
turning `highlight_on_cursor` off mid-session: new outlines stop immediately,
but an outline already on screen stays until the next preview open or stop
(emphasis frames are transient and last-wins; nothing repaints on a config
change alone).

## How install works

- **Supported platforms** get a prebuilt single-file binary, fetched from the
  pinned GitHub Release and verified against the committed `checksums.txt`
  before it is ever executed. Verification is fail-closed: a checksum mismatch,
  truncated download, or failed promotion means the binary is **not** run.
  Prebuilt targets: macOS `x64`/`arm64`, Linux `x64`/`arm64` (glibc **and**
  musl), and Windows `x64`.
- **Uncovered platforms** (e.g. BSD, Windows on `arm64`) fall back to building the server
  from source with Bun (`bun build --compile`), loudly and explicitly. This
  requires Bun ≥ 1.3.10; if Bun is missing or too old, the install fails fast
  with a clear message naming Bun as the prerequisite.

In both cases the server is a compiled executable spawned directly by Neovim and
supervised over stdin — there is no wrapper process that could orphan it.

## Health check

```
:checkhealth interactive-graphviz
```

Reports Neovim version, that `checksums.txt` is present and parseable, the
mapped prebuilt binary's presence and checksum, Bun availability/version (for
the fallback), and localhost port-bind capability.

## Security

- The preview server binds **`127.0.0.1` (loopback) by default**. Setting
  `expose_to_lan = true` is the *only* way to bind `0.0.0.0`, and it is a
  deliberate, explicit opt-in.
- Sessions are token-gated: the browser URL carries a per-session token.
- Installs are integrity-checked: prebuilt binaries are SHA-256 verified against
  the in-source, tag-pinned `checksums.txt` (not a mutable remote manifest)
  before execution.

## Non-goals

Auto-open on filetype, raster image (PNG) export, layout engines beyond
`dot`/`neato`, editing the buffer from the preview, and raising/focusing
windows across the editor↔browser boundary are intentionally out of scope.
(SVG download and interactive-HTML export shipped in v0.5.0 — see the view
toolbar.)

## License

See [LICENSE](LICENSE).
