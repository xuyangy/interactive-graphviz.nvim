// interact.ts — pure click-to-highlight model for Story 5.2.
//
// Mirrors viewstate.ts's design exactly: this module is PURE — no DOM, no
// d3-graphviz / @hpcc-js/wasm import. It holds the graph model, the highlight
// math (`computeHighlightSet`), the selection state machine, the cluster
// membership derivation, and the frontend-local `highlight_mode` resolver.
// render.ts is the only module that touches the live SVG; it extracts the graph
// model (from SVG <title> elements) and feeds it into this module's pure logic,
// then applies the resulting highlight set back onto the DOM.
//
// Keeping the highlight MATH pure (operating on an injected {nodes, edges, ...}
// model) means it is `bun test`-able exactly like dot.ts / viewstate.ts, while
// the graph-model EXTRACTION source (DOT parse vs SVG titles) can vary. We ship
// both: a pragmatic DOT parser (`parseDotModel`) and an SVG-title model builder
// (`buildModelFromTitles`) — both pure — and render.ts picks the SVG-title
// source at apply time (robust: mirrors what is actually drawn). See the Dev
// Agent Record for the chosen extraction source.

// ── Highlight modes (FR-14 config seam) ───────────────────────────────────────

export type HighlightMode = "single" | "upstream" | "downstream" | "bidirectional";

const HIGHLIGHT_MODES: readonly HighlightMode[] = [
  "single",
  "upstream",
  "downstream",
  "bidirectional",
];

const DEFAULT_HIGHLIGHT_MODE: HighlightMode = "bidirectional";

// `highlight_mode` is an architecture FR-14 config seam, NOT yet a Lua config
// key. AC5 forbids new wire surface / Lua protocol changes, so the frontend
// resolves it locally — exactly mirroring viewstate.ts's `_preserveView`.
// Default "bidirectional" matches the architecture seam default and zero-config.
let _highlightMode: HighlightMode = DEFAULT_HIGHLIGHT_MODE;

/** True when `m` is one of the four valid highlight modes. */
export function isHighlightMode(m: unknown): m is HighlightMode {
  return typeof m === "string" && (HIGHLIGHT_MODES as readonly string[]).includes(m);
}

/**
 * Set the resolved highlight mode. Unknown / invalid values clamp to the
 * default ("bidirectional"), so a bad config never breaks the interaction.
 */
export function setHighlightMode(mode: unknown): void {
  _highlightMode = isHighlightMode(mode) ? mode : DEFAULT_HIGHLIGHT_MODE;
}

/** Current resolved highlight mode (default "bidirectional"). */
export function getHighlightMode(): HighlightMode {
  return _highlightMode;
}

// ── Graph model ───────────────────────────────────────────────────────────────

/** A directed edge between two node titles (Graphviz node names). */
export interface Edge {
  from: string;
  to: string;
  /** undirected (`a -- b`) edges count both directions as neighbors. */
  undirected?: boolean;
}

/** Stable string key for an edge, used to address rendered edge groups. */
export type EdgeKey = string;

/**
 * The pure graph model the highlight math operates on. `clusters` maps a cluster
 * name (e.g. "cluster_a") to the set of member node titles.
 */
export interface GraphModel {
  nodes: Set<string>;
  edges: Edge[];
  clusters: Map<string, Set<string>>;
}

/**
 * Edge key for a directed pair. Graphviz SVG edge <title> text is `A->B` for
 * directed graphs and `A--B` for undirected; we mirror that so the key matches
 * what render.ts reads off the live SVG.
 */
export function edgeKey(from: string, to: string, undirected = false): EdgeKey {
  return `${from}${undirected ? "--" : "->"}${to}`;
}

export function emptyModel(): GraphModel {
  return { nodes: new Set(), edges: [], clusters: new Map() };
}

// ── DOT parsing (pure, pragmatic) ─────────────────────────────────────────────
// Full DOT is non-trivial (subgraphs, ports, attribute lists, quoted ids,
// comments). This parser is intentionally pragmatic: it handles the common
// shapes — `a -> b`, `a -- b`, chained `a -> b -> c`, quoted ids, attribute
// lists (skipped), line/block comments, and `subgraph cluster_* { ... }` blocks
// for cluster membership. Documented limitations: ports (`a:p -> b:q`) are
// reduced to their node id; HTML-like labels and deeply nested non-cluster
// subgraphs are not modeled beyond their node/edge statements.

function stripComments(src: string): string {
  // Remove /* block */ and // line and # line comments.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  out = out.replace(/\/\/[^\n]*/g, " ");
  out = out.replace(/^[ \t]*#[^\n]*/gm, " ");
  return out;
}

/** Normalize a raw token id: strip quotes, strip a `:port` / `:port:compass`. */
function normalizeId(raw: string): string {
  let id = raw.trim();
  if (id.length === 0) return id;
  if (id.startsWith('"') && id.endsWith('"') && id.length >= 2) {
    // Quoted id: unescape \" and \\ ; keep inner content verbatim (ports inside
    // a quoted id are part of the name, so do not strip them here).
    return id.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  // Unquoted id: a `:port` suffix addresses a record/compass point — drop it so
  // adjacency keys on the node, matching the SVG node <title> (the node name).
  const colon = id.indexOf(":");
  if (colon !== -1) id = id.slice(0, colon);
  return id;
}

// Matches a single id (quoted or bare) at the start of `s`; returns [id, rest].
function takeId(s: string): [string, string] | null {
  const t = s.replace(/^[\s,]+/, "");
  if (t.length === 0) return null;
  if (t[0] === '"') {
    // Quoted: read until the closing unescaped quote.
    let i = 1;
    while (i < t.length) {
      if (t[i] === "\\") {
        i += 2;
        continue;
      }
      if (t[i] === '"') break;
      i++;
    }
    const raw = t.slice(0, i + 1);
    return [raw, t.slice(i + 1)];
  }
  // Bare id: alnum, underscore, dot, and `:` (port) until whitespace/operator.
  const m = t.match(/^[A-Za-z0-9_.:]+/);
  if (!m) return null;
  return [m[0], t.slice(m[0].length)];
}

const KEYWORDS = new Set(["node", "edge", "graph", "digraph", "subgraph", "strict"]);

function isKeyword(id: string): boolean {
  return KEYWORDS.has(id.toLowerCase());
}

/**
 * Parse a DOT string into a pure GraphModel (nodes, directed/undirected edges,
 * cluster membership). DOM-free and dependency-free — unit-testable like dot.ts.
 *
 * Direction: a `digraph` / `->` edge is directed (drives upstream/downstream);
 * a `graph` / `--` edge is undirected and treats both endpoints as neighbors.
 */
export function parseDotModel(dot: string): GraphModel {
  const model = emptyModel();
  if (!dot || dot.trim().length === 0) return model;

  const src = stripComments(dot);

  // Track cluster nesting by scanning subgraph headers and braces. We record,
  // for each open brace depth, the active cluster name (or null). A node id seen
  // while a cluster is the innermost active cluster is a member of that cluster.
  const clusterStack: (string | null)[] = [];

  // Tokenize line-ish by splitting on `;` and newlines but keep edge chains
  // intact by scanning statements. We process the source char-stream with a
  // small statement accumulator that respects braces.
  let i = 0;
  let stmt = "";
  // Lookahead helper for `subgraph cluster_x {` detection on a brace.
  const flushStatement = (s: string) => {
    parseStatement(s, model, currentCluster(clusterStack));
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      // The statement text BEFORE the brace may be a subgraph header.
      const name = subgraphClusterName(stmt);
      // Any pending statement before the brace (non-subgraph) is flushed.
      const pre = stmt.replace(/\b(strict\s+)?(di)?graph\b[^{]*$/i, "").trim();
      if (name === undefined && pre.length > 0 && !/\bsubgraph\b/i.test(stmt)) {
        flushStatement(pre);
      }
      clusterStack.push(name ?? null);
      if (name && !model.clusters.has(name)) model.clusters.set(name, new Set());
      stmt = "";
      i++;
      continue;
    }
    if (ch === "}") {
      if (stmt.trim().length > 0) flushStatement(stmt);
      stmt = "";
      clusterStack.pop();
      i++;
      continue;
    }
    if (ch === ";") {
      if (stmt.trim().length > 0) flushStatement(stmt);
      stmt = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      // Newlines also terminate statements in practice (DOT allows it when no
      // operator continuation is pending). Be conservative: only flush if the
      // accumulated statement has no trailing edge operator.
      if (stmt.trim().length > 0 && !/(-[->])\s*$/.test(stmt.trim())) {
        flushStatement(stmt);
        stmt = "";
      }
      i++;
      continue;
    }
    stmt += ch;
    i++;
  }
  if (stmt.trim().length > 0) flushStatement(stmt);

  return model;
}

function currentCluster(stack: (string | null)[]): string | null {
  for (let j = stack.length - 1; j >= 0; j--) {
    if (stack[j] != null) return stack[j];
  }
  return null;
}

// Returns the cluster name if `stmt` (text before a `{`) is a `subgraph
// cluster_*` header; undefined otherwise (non-cluster subgraph or graph body).
function subgraphClusterName(stmt: string): string | undefined {
  const m = stmt.match(/\bsubgraph\s+("?)(cluster_[A-Za-z0-9_.]*)\1\s*$/i);
  if (m) return m[2];
  return undefined;
}

/**
 * Parse a single statement (no `;`/`{`/`}`) into the model under the active
 * cluster. Handles edge chains (`a -> b -> c`), single node decls, and skips
 * attribute lists `[...]` and bare attribute assignments (`rankdir=LR`).
 */
function parseStatement(rawStmt: string, model: GraphModel, cluster: string | null): void {
  // Drop any attribute list `[ ... ]`.
  let s = rawStmt.replace(/\[[^\]]*\]/g, " ").trim();
  if (s.length === 0) return;

  // Skip standalone attribute assignments at graph/subgraph scope (e.g.
  // `rankdir=LR`, `label="x"`) — no `->`/`--` and contains `=` but no edge op.
  if (!/-[->]/.test(s) && /=/.test(s)) return;

  // Skip pure keyword/attr statements like `node [shape=box]` (already had its
  // [...] stripped, leaving just `node`).
  const firstTok = takeId(s);
  if (firstTok && isKeyword(normalizeIdKeyword(firstTok[0])) && !/-[->]/.test(s)) {
    // A lone keyword (node/edge/graph default-attr stmt) with no edge: ignore.
    return;
  }

  // Split the statement into operator-separated id segments while detecting
  // direction. We walk ids and the operator between them.
  const ids: string[] = [];
  const ops: ("->" | "--")[] = [];
  let rest = s;
  while (rest.trim().length > 0) {
    const got = takeId(rest);
    if (!got) break;
    const [rawId, after] = got;
    const norm = normalizeId(rawId);
    if (norm.length === 0 || isKeyword(norm)) {
      // Stop if we hit a keyword mid-statement (defensive).
      rest = after;
      if (isKeyword(norm)) continue;
      break;
    }
    ids.push(norm);
    const m = after.match(/^\s*(->|--)/);
    if (m) {
      ops.push(m[1] as "->" | "--");
      rest = after.slice(m[0].length);
    } else {
      rest = after;
      break;
    }
  }

  if (ids.length === 0) return;

  // Register all nodes (including a single node decl).
  for (const id of ids) {
    model.nodes.add(id);
    if (cluster) {
      const set = model.clusters.get(cluster) ?? new Set<string>();
      set.add(id);
      model.clusters.set(cluster, set);
    }
  }

  // Register edges for each consecutive pair using the operator between them.
  for (let k = 0; k < ops.length && k + 1 < ids.length; k++) {
    const undirected = ops[k] === "--";
    model.edges.push({ from: ids[k], to: ids[k + 1], undirected });
  }
}

// normalizeId strips ports for keyword detection too; expose the bare token.
function normalizeIdKeyword(raw: string): string {
  return normalizeId(raw);
}

// ── SVG-title model builder (pure, given extracted title strings) ─────────────
// render.ts reads the <title> text out of the live SVG (robust: mirrors what is
// actually drawn) and passes the raw strings here. This keeps the parsing of
// title text pure and unit-testable while the DOM read stays in render.ts.

export interface SvgTitles {
  /** Node <title> texts (each is a node name). */
  nodeTitles: string[];
  /** Edge <title> texts (each is `A->B` or `A--B`). */
  edgeTitles: string[];
  /** Cluster <title> texts (each is `cluster_<name>`); membership derived from edges/nodes geometry is not available, so clusters from titles only name the cluster. */
  clusterTitles?: string[];
}

/**
 * Build a GraphModel from SVG <title> strings. Edge titles encode endpoints as
 * `A->B` (directed) or `A--B` (undirected). Cluster membership is NOT derivable
 * from SVG titles alone (titles only name the cluster), so callers that need
 * cluster membership should use the DOT parse. This builder fills clusters with
 * empty member sets for any cluster titles so the names are still known.
 */
export function buildModelFromTitles(titles: SvgTitles): GraphModel {
  const model = emptyModel();
  for (const n of titles.nodeTitles) {
    const name = n.trim();
    if (name.length > 0) model.nodes.add(name);
  }
  for (const raw of titles.edgeTitles) {
    const parsed = parseEdgeTitle(raw);
    if (!parsed) continue;
    model.nodes.add(parsed.from);
    model.nodes.add(parsed.to);
    model.edges.push(parsed);
  }
  for (const c of titles.clusterTitles ?? []) {
    const name = c.trim();
    if (name.length > 0 && !model.clusters.has(name)) model.clusters.set(name, new Set());
  }
  return model;
}

/** Parse an edge <title> text (`A->B` / `A--B`) into an Edge. */
export function parseEdgeTitle(title: string): Edge | null {
  const t = title.trim();
  // Prefer `->` (directed). Use indexOf so node names containing `-` survive
  // (we split on the first operator occurrence).
  const arrow = t.indexOf("->");
  if (arrow !== -1) {
    const from = t.slice(0, arrow).trim();
    const to = t.slice(arrow + 2).trim();
    if (from && to) return { from, to, undirected: false };
    return null;
  }
  const dash = t.indexOf("--");
  if (dash !== -1) {
    const from = t.slice(0, dash).trim();
    const to = t.slice(dash + 2).trim();
    if (from && to) return { from, to, undirected: true };
    return null;
  }
  return null;
}

// ── Highlight computation (pure) ──────────────────────────────────────────────

export interface HighlightSet {
  /** Node titles to emphasize (selected ∪ neighbors). */
  nodes: Set<string>;
  /** Edge keys to emphasize (the connecting edges). */
  edges: Set<EdgeKey>;
  /** The originally-selected node titles (strongest emphasis). */
  selected: Set<string>;
}

export function emptyHighlightSet(): HighlightSet {
  return { nodes: new Set(), edges: new Set(), selected: new Set() };
}

/**
 * Compute the highlight set for a selection under a mode.
 *
 * - `single`        — just the selected node(s), no neighbors, no edges.
 * - `upstream`      — predecessors (incoming-edge sources) + connecting edges.
 * - `downstream`    — successors (outgoing-edge targets) + connecting edges.
 * - `bidirectional` — both directions.
 *
 * Undirected edges (`a -- b`) treat both endpoints as neighbors in every
 * directional mode. For multi-select, the per-node sets are unioned.
 */
export function computeHighlightSet(
  model: GraphModel,
  selectedNodes: string[],
  mode: HighlightMode,
): HighlightSet {
  const result = emptyHighlightSet();
  for (const sel of selectedNodes) {
    if (!model.nodes.has(sel)) continue; // selecting a non-existent node = no-op
    result.selected.add(sel);
    result.nodes.add(sel);
  }
  if (result.selected.size === 0) return result;
  if (mode === "single") return result;

  const wantUp = mode === "upstream" || mode === "bidirectional";
  const wantDown = mode === "downstream" || mode === "bidirectional";

  for (const e of model.edges) {
    const undirected = e.undirected === true;
    // Downstream: selected --edge--> neighbor (target). For undirected, either end.
    if (wantDown) {
      if (result.selected.has(e.from)) {
        result.nodes.add(e.to);
        result.edges.add(edgeKey(e.from, e.to, undirected));
      } else if (undirected && result.selected.has(e.to)) {
        result.nodes.add(e.from);
        result.edges.add(edgeKey(e.from, e.to, undirected));
      }
    }
    // Upstream: neighbor (source) --edge--> selected. For undirected, either end.
    if (wantUp) {
      if (result.selected.has(e.to)) {
        result.nodes.add(e.from);
        result.edges.add(edgeKey(e.from, e.to, undirected));
      } else if (undirected && result.selected.has(e.from)) {
        result.nodes.add(e.to);
        result.edges.add(edgeKey(e.from, e.to, undirected));
      }
    }
  }
  return result;
}

// ── Cluster membership (pure) ─────────────────────────────────────────────────

/**
 * Return the name of the cluster containing `node`, or null if it is not in any
 * cluster. If a node is (pathologically) in multiple clusters, the first match
 * by insertion order is returned.
 */
export function clusterOf(model: GraphModel, node: string): string | null {
  for (const [name, members] of model.clusters) {
    if (members.has(node)) return name;
  }
  return null;
}

/**
 * Compute the cluster-highlight set for a clicked node: all member nodes of the
 * cluster the node lives in, plus all intra-cluster edges (both endpoints in the
 * cluster). Returns an empty set when the node is not in any cluster.
 */
export function computeClusterHighlightSet(model: GraphModel, node: string): HighlightSet {
  const result = emptyHighlightSet();
  const name = clusterOf(model, node);
  if (!name) return result;
  const members = model.clusters.get(name);
  if (!members || members.size === 0) return result;

  result.selected.add(node);
  for (const m of members) result.nodes.add(m);
  for (const e of model.edges) {
    if (members.has(e.from) && members.has(e.to)) {
      result.edges.add(edgeKey(e.from, e.to, e.undirected === true));
    }
  }
  return result;
}

/** Union of two highlight sets (selected ∪ selected, nodes ∪ nodes, edges ∪ edges). */
export function unionHighlight(a: HighlightSet, b: HighlightSet): HighlightSet {
  return {
    nodes: new Set([...a.nodes, ...b.nodes]),
    edges: new Set([...a.edges, ...b.edges]),
    selected: new Set([...a.selected, ...b.selected]),
  };
}

// ── Selection state machine (pure / injectable) ───────────────────────────────
// Holds the current selection set. Plain click replaces; Shift+click unions;
// Esc / empty-canvas clears. Pure: no DOM. render.ts drives it from real events
// and asks computeHighlightSet for the emphasis set to apply.

export class Selection {
  private readonly _nodes = new Set<string>();

  /** Plain click: replace the selection with a single node. */
  set(node: string): void {
    this._nodes.clear();
    this._nodes.add(node);
  }

  /** Shift+click: add a node to the current selection (union). */
  add(node: string): void {
    this._nodes.add(node);
  }

  /** Esc / empty-canvas click: clear the selection. */
  clear(): void {
    this._nodes.clear();
  }

  /** True when nothing is selected. */
  isEmpty(): boolean {
    return this._nodes.size === 0;
  }

  /** Snapshot of the selected node titles (insertion order). */
  toArray(): string[] {
    return [...this._nodes];
  }

  /** Drop selected nodes that no longer exist in `model` (live-reload prune). */
  retain(model: GraphModel): void {
    for (const n of [...this._nodes]) {
      if (!model.nodes.has(n)) this._nodes.delete(n);
    }
  }
}

// ── Esc-to-clear keydown predicate (pure) ─────────────────────────────────────
// Mirrors render.ts's `shouldReset` shape so the gesture decision is unit-tested
// without a DOM. Esc is shared with search (Story 5.3), so skip when typing in
// an INPUT/TEXTAREA — search owns text input and its own Esc-closes-search.

export interface ClearKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** True when this keydown should clear the active highlight (un-modified Esc, not in a text field). */
export function shouldClearHighlight(e: ClearKeyEvent, activeTag: string | undefined): boolean {
  if (e.key !== "Escape") return false;
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return true;
}

// ── Test seam ──────────────────────────────────────────────────────────────
/** Reset the module-level highlight mode to the default. Tests only. */
export function _resetHighlightMode(): void {
  _highlightMode = DEFAULT_HIGHLIGHT_MODE;
}
