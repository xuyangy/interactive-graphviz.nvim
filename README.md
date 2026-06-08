# interactive-graphviz.nvim

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
  "xuyangy/interactive-graphviz.nvim",
  ft = { "dot" },
  opts = {}, -- calls require("interactive-graphviz").setup{}; zero-config works
}
```

[packer.nvim](https://github.com/wbthomason/packer.nvim):

```lua
use({
  "xuyangy/interactive-graphviz.nvim",
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

Edits to the buffer re-render automatically (debounced, latest-wins). On a bad
graph the last good render is kept and an error is shown rather than blanking
the preview.

### Navigating the graph (in the browser)

The preview is interactive — navigate large graphs without leaving Neovim:

| Gesture | Action |
| --- | --- |
| Scroll wheel | Zoom in / out |
| Click + drag | Pan |
| `0` or `r` | Reset the view to fit the viewport |
| Click a node | Highlight it and its neighbors; dim the rest |
| Shift + click | Add another node to the highlight (multi-select) |
| Alt + click | Also highlight the whole cluster the node lives in |
| `/` | Open the live-search box (type to filter nodes / edges) |
| `Esc` | Close search if open, otherwise clear all highlighting |
| Click empty canvas | Clear all highlighting |

When `preserve_view = true` (the default), your current zoom/pan is kept across
live-reload re-renders, so editing the buffer no longer snaps you back to the
top of the graph. Set `preserve_view = false` to reset to fit on every reload.

### Highlighting neighbors

Click any node to trace its relationships: the clicked node and its neighbors
are emphasized while everything else dims. Which neighbors light up follows the
`highlight_mode`:

| `highlight_mode` | Highlights |
| --- | --- |
| `single` | Just the clicked node (no neighbors) |
| `upstream` | Predecessors (incoming-edge sources) + the connecting edges |
| `downstream` | Successors (outgoing-edge targets) + the connecting edges |
| `bidirectional` (default) | Both directions |

Shift + click adds more nodes to the highlight set, Alt + click also lights up
the whole cluster a node belongs to, and `Esc` (or a click on the empty canvas)
clears everything back to full opacity. Highlighting survives live-reload: it is
re-applied to the new render as long as the selected nodes still exist.

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

Press `Esc` to close the search box and clear its highlight, returning every
element to full opacity. Search highlighting survives live-reload: while the box
is open, the query is re-applied against each new render.

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
  heartbeat_ms = 2000,       -- supervision heartbeat interval (ms), > 0
  log_level = "warn",        -- off | error | warn | info | debug
})
```

Invalid values are rejected with a warning and fall back to the default rather
than failing setup. Note that `bind` is **not** a user-settable key — the bind
address is controlled exclusively by `expose_to_lan` (see Security).

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

## Non-goals (v1)

Auto-open on filetype, image/SVG export, layout engines beyond `dot`/`neato`,
and richer in-browser interactivity are intentionally out of scope for v1.

## License

See [LICENSE](LICENSE).
