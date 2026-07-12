import { expect, test } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isReady, type Ready } from "../../server/protocol";

// Real-browser smoke test — the ONLY automated coverage of the actual WASM
// layout/render path (everything else runs under happy-dom, which cannot
// execute Graphviz-WASM, d3-zoom gestures, or real rendering; see MEMORY
// browser-render-untested). Deliberately tiny by design: open the real
// preview, deliver one render through the real server, assert the toolbar,
// a real laid-out SVG, and one interaction. It guards user-visible behavior
// only — no module internals, no DOM ids beyond the stable public surfaces —
// so the planned render.ts refactor can move code without churning this test.

const SERVER = fileURLToPath(new URL("../../server/server.ts", import.meta.url));

let proc: ChildProcess;
let ready: Ready;

// Spawn the real server (same entrypoint the Lua plugin runs) and read its
// ready{port,token} announcement. stdout is the protocol channel, but the test
// harness is deliberately tolerant of environment/Bun noise before the first
// protocol frame.
test.beforeAll(async () => {
  proc = spawn("bun", ["run", SERVER], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, IG_HEARTBEAT_TIMEOUT_MS: "120000" },
  });
  ready = await new Promise<Ready>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("server never announced ready"));
      }
    }, 10_000);
    const finish = (r: Ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trimStart().startsWith("{")) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (isReady(parsed)) finish(parsed);
      }
    });
    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.on("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`server exited before ready (code=${code}, signal=${signal})`));
      }
    });
  });
});

test.afterAll(() => {
  proc?.kill();
});

test("preview renders a real graph and click-highlight works", async ({ page }) => {
  // session_open + render delivered over stdin exactly as the Lua plugin
  // sends them (:GraphvizPreview order). Written before the page connects —
  // the server replays lastGoodRender on a valid hello, so this is not a race.
  proc.stdin!.write(`${JSON.stringify({ type: "session_open", sessionId: 1 })}\n`);
  // Every node lives in a cluster so the cluster-dim rule is observable on a
  // REAL graphviz SVG: clicking a lights b (neighbor) but not c, so a's and
  // b's boxes must stay lit while c's dims with its only member. The lit pair
  // covers both ways graphviz decides cluster-ness — the DIM direction cannot
  // discriminate (a parser miss also dims): cluster0 is deliberately
  // underscore-less (clustering is by name PREFIX), and x has no prefix at
  // all, promoted via the cluster=true attribute (graphviz ≥2.50). The
  // DOT-side membership parse must agree with both or a lit box dims wrongly.
  proc.stdin!.write(
    `${JSON.stringify({
      type: "render",
      sessionId: 1,
      dot:
        "digraph { subgraph cluster0 { a } subgraph x { cluster=true; b } " +
        "subgraph cluster_y { c } a -> b; b -> c }",
      engine: "dot",
      v: 1,
    })}\n`,
  );

  // animate=0 is the real wire encoding commands.lua appends for
  // setup{animate=false} (urlconfig booleans accept exactly "1"/"0") —
  // determinism for the click below (Playwright's actionability check waits
  // for a stable bounding box, and the d3 render transition otherwise keeps
  // the nodes in motion).
  await page.goto(`http://127.0.0.1:${ready.port}/?sessionId=1&token=${ready.token}&animate=0`);

  // The real WASM layout produced a real SVG: all three nodes exist as
  // graphviz-shaped groups. Generous timeout — first render loads the WASM.
  const nodes = page.locator("#app svg g.node");
  await expect(nodes).toHaveCount(3, { timeout: 20_000 });

  // The view toolbar is up (public UI surface, not an internal module detail).
  await expect(page.locator("#ig-view-toolbar")).toBeVisible();

  // Even with animate=false, d3-graphviz pans/zooms the fresh render to fit
  // the viewport (a d3-zoom transition, not the gated render transition).
  // Wait for the graph to stop moving before clicking: poll until the first
  // node's bounding box is identical across two consecutive 200ms samples.
  await page.waitForFunction(async () => {
    const el = document.querySelector("#app svg g.node");
    if (!el) return false;
    const before = JSON.stringify(el.getBoundingClientRect());
    await new Promise((r) => setTimeout(r, 200));
    return JSON.stringify(el.getBoundingClientRect()) === before;
  });

  // One real interaction: click node "a" → it is emphasized, and its
  // downstream neighbor "b" lights up too (default bidirectional mode).
  const nodeA = page.locator("g.node", { has: page.locator('title:text-is("a")') });
  const nodeB = page.locator("g.node", { has: page.locator('title:text-is("b")') });
  // Click the group, not the ellipse: the node's <text> label covers the
  // ellipse's center, and the click handler accepts any descendant anyway.
  await nodeA.click();
  await expect(nodeA).toHaveClass(/ig-selected/);
  await expect(nodeB).toHaveClass(/ig-neighbor/);

  // Cluster boxes follow their contents: cluster0 holds the selected a and x
  // holds the lit neighbor b → both stay at full opacity; cluster_y's only
  // member c is dimmed → the box + title dim with it (this was the bug:
  // subgraph boxes never dimmed).
  const clusterSel = page.locator("g.cluster", { has: page.locator('title:text-is("cluster0")') });
  const clusterNbr = page.locator("g.cluster", { has: page.locator('title:text-is("x")') });
  const clusterFar = page.locator("g.cluster", { has: page.locator('title:text-is("cluster_y")') });
  await expect(clusterFar).toHaveClass(/ig-dimmed/);
  await expect(clusterSel).not.toHaveClass(/ig-dimmed/);
  await expect(clusterNbr).not.toHaveClass(/ig-dimmed/);
  expect(await clusterFar.evaluate((el) => getComputedStyle(el).opacity)).toBe("0.15");

  // Fit-to-selection (plan item #6): with a-and-neighbors highlighted, `f`
  // re-frames the view around them — the zoom transform must change (applied
  // instantly under animate=0). `0` then resets so the rest of the flow sees
  // the same initial fit it did before this leg.
  const graphTransform = () =>
    page.evaluate(() => document.querySelector("#app svg g.graph")?.getAttribute("transform") ?? "");
  const beforeFit = await graphTransform();
  await page.keyboard.press("f");
  await expect.poll(graphTransform).not.toBe(beforeFit);
  const fitted = await graphTransform();
  await page.keyboard.press("0");
  await expect.poll(graphTransform).not.toBe(fitted);

  // Fit-graph-to-window (`Shift+F`): unlike `0` — which replays the transform
  // frozen at render time — the whole-graph fit is recomputed from the LIVE
  // window geometry, so it is the affordance that answers a browser resize.
  // Shrink the window: the same key must land on a NEW transform. A second
  // Shift+F at the restored size re-fits, leaving every node in-viewport for
  // the legs below.
  const beforeResize = await graphTransform();
  await page.setViewportSize({ width: 640, height: 400 });
  await page.keyboard.press("Shift+F");
  await expect.poll(graphTransform).not.toBe(beforeResize);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press("Shift+F");

  // Pan-scroll mode (`p`): the wheel PANS instead of zooming — the transform's
  // translate moves while the SCALE stays exactly put (a zoom would change k),
  // and Shift+wheel pans horizontally. d3-zoom's transform is always
  // "translate(x,y) scale(k)".
  const parseTransform = async () => {
    const m = /translate\((-?[\d.eE+]+)[ ,](-?[\d.eE+]+)\)\s*scale\((-?[\d.eE+]+)/.exec(
      await graphTransform(),
    );
    if (!m) throw new Error("unparseable zoom transform");
    return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
  };
  await page.mouse.move(640, 360); // wheel events target the hovered element
  const beforePan = await parseTransform();
  await page.keyboard.press("p");
  await page.mouse.wheel(0, 120);
  await expect
    .poll(async () => {
      const t = await parseTransform();
      // Scrolling down moves the view down = content translates UP (y shrinks).
      return t.k === beforePan.k && t.y < beforePan.y && t.x === beforePan.x;
    })
    .toBe(true);
  const beforeShiftPan = await parseTransform();
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 120);
  await page.keyboard.up("Shift");
  await expect
    .poll(async () => {
      const t = await parseTransform();
      return t.k === beforeShiftPan.k && t.x < beforeShiftPan.x && t.y === beforeShiftPan.y;
    })
    .toBe(true);
  // Toggle pan mode OFF and re-fit so the legs below keep wheel=zoom and
  // every node in-viewport.
  await page.keyboard.press("p");
  await page.keyboard.press("Shift+F");

  // Esc clears the emphasis — the interaction is live, not a one-way latch.
  await page.keyboard.press("Escape");
  await expect(nodeA).not.toHaveClass(/ig-selected/);

  // Live reload: a second render rebuilds the SVG subtree; interactions must
  // work against the NEW elements (guards the graph-dom snapshot cache — a
  // stale cache would toggle classes on detached nodes and nothing would
  // highlight).
  proc.stdin!.write(
    `${JSON.stringify({
      type: "render",
      sessionId: 1,
      dot: "digraph { a -> b; b -> c; c -> d }",
      engine: "dot",
      v: 2,
    })}\n`,
  );
  await expect(page.locator("#app svg g.node")).toHaveCount(4, { timeout: 10_000 });
  const nodeD = page.locator("g.node", { has: page.locator('title:text-is("d")') });
  await nodeD.click();
  await expect(nodeD).toHaveClass(/ig-selected/);

  // Theming (plan item #5): flipping the OS color scheme themes the canvas and
  // remaps the graph's DEFAULT colors live — pure CSS, no re-render. Clear the
  // highlight first so the sampled ellipse carries the default stroke, not the
  // ig-selected accent.
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe("rgb(255, 255, 255)"); // light: Graphviz-native white canvas
  await page.emulateMedia({ colorScheme: "dark" });
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe("rgb(30, 30, 30)"); // --ig-canvas-bg dark
  // Poll: d3-graphviz's render transition tweens color attributes for a
  // moment after a render; the remap holds once the attributes settle.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => getComputedStyle(document.querySelector("#app svg g.node ellipse")!).stroke,
        ),
      { timeout: 5_000 },
    )
    .toBe("rgb(212, 212, 212)"); // default stroke="black" remapped to --ig-graph-fg

  // Live config push (plan item #3): a config_update over stdin (what a re-run
  // setup{} sends) reaches the OPEN page and re-shapes interaction without a
  // reload — with highlight_mode switched to "single", a click emphasizes only
  // the clicked node and the neighbor dims instead of lighting up. Click node
  // d (proven in-viewport above — preserve_view keeps the pre-reload zoom, so
  // other nodes may sit off-screen) and watch its neighbor c. Poll: the
  // frame's arrival is async, so re-try the click until the new mode is live.
  proc.stdin!.write(
    `${JSON.stringify({
      type: "config_update",
      sessionId: 1,
      config: { highlight_mode: "single" },
    })}\n`,
  );
  const nodeC = page.locator("g.node", { has: page.locator('title:text-is("c")') });
  await expect
    .poll(
      async () => {
        await page.keyboard.press("Escape");
        await nodeD.click();
        return (await nodeC.getAttribute("class")) ?? "";
      },
      { timeout: 5_000 },
    )
    .toContain("ig-dimmed");
  await expect(nodeD).toHaveClass(/ig-selected/);

  // Error recovery keeps the interaction state: a broken DOT shows the error
  // overlay and the fallback render restores the last good graph — with the
  // ACTIVE click selection re-applied to it (the recovery render rebuilds the
  // SVG subtree; without the post-recovery reapply, d's highlight vanished
  // while its selection state stayed active). Node d is still selected from
  // the config_update leg above.
  proc.stdin!.write(
    `${JSON.stringify({
      type: "render",
      sessionId: 1,
      dot: "digraph { a -> }", // dangling edge: guaranteed parse error
      engine: "dot",
      v: 3,
    })}\n`,
  );
  await expect(page.locator("#ig-error-overlay")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#app svg g.node")).toHaveCount(4); // last good graph restored
  await expect(nodeD).toHaveClass(/ig-selected/, { timeout: 5_000 });
  await expect(nodeC).toHaveClass(/ig-dimmed/);

  // Cursor-echo glow (v0.12.0 issue triage 2026-07-12): three laws under a
  // REAL engine. (1) The glow is a real SVG <filter> referenced via
  // filter:url() — WebKit doesn't reliably render CSS filter functions on SVG
  // elements, so drop-shadow() showed nothing in Safari. (2) The bloom
  // animates stroke-width only — an animated filter re-blurred every frame in
  // Firefox (~500% CPU). (3) Phase sync: an endpoint that KEEPS its class
  // across a node-line → edge-line move must not keep an old animation phase
  // while the edge + other endpoint start fresh (the endpoints blinked
  // alternately). Clear the click highlight first so the cursor rules (which
  // yield to ig-selected/ig-neighbor) own every target.
  await page.keyboard.press("Escape");
  proc.stdin!.write(
    `${JSON.stringify({ type: "config_update", sessionId: 1, config: { animate: "1" } })}\n`,
  );
  // Rest the cursor on node b's line…
  proc.stdin!.write(`${JSON.stringify({ type: "emphasize", sessionId: 1, nodeId: "b" })}\n`);
  await expect(nodeB).toHaveClass(/ig-cursor/);
  // …then half a bloom cycle later move onto its edge line b->c: b keeps its
  // class (classList.add is a no-op — no animation restart) while the edge
  // and c match the animation rule fresh. This is the exact desync recipe.
  await page.waitForTimeout(600);
  proc.stdin!.write(`${JSON.stringify({ type: "emphasize", sessionId: 1, nodeId: "b->c" })}\n`);
  const edgeBC = page.locator("g.edge", { has: page.locator('title:text-is("b->c")') });
  await expect(edgeBC).toHaveClass(/ig-cursor/);
  await expect(nodeC).toHaveClass(/ig-cursor/);
  // The filter def exists in its body-level carrier svg (outside the graph
  // svg — inside it, d3-graphviz's next re-render data join breaks), and the
  // emphasized edge's computed style references it.
  expect(
    await page.evaluate(
      () =>
        !!document.querySelector("svg#ig-cursor-glow-defs defs > filter#ig-cursor-glow > feGaussianBlur") &&
        !document.querySelector("#app filter#ig-cursor-glow"),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector("#app g.edge.ig-cursor")!).filter,
    ),
  ).toContain("url(");
  // Every running bloom is pinned to the document-timeline origin, so their
  // currentTimes (sampled in one evaluate tick) are identical ⇒ same phase.
  const phases = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => (a as CSSAnimation).animationName === "ig-cursor-bloom")
      .map((a) => ({ start: a.startTime, t: Math.round(a.currentTime as number) })),
  );
  expect(phases.length).toBeGreaterThanOrEqual(3); // b + c ellipses, edge spline (+arrowhead)
  for (const p of phases) expect(p.start).toBe(0);
  expect(new Set(phases.map((p) => p.t)).size).toBe(1);
  // Clear the emphasis and re-disable animation so later legs stay deterministic.
  proc.stdin!.write(`${JSON.stringify({ type: "emphasize", sessionId: 1, nodeId: null })}\n`);
  await expect(edgeBC).not.toHaveClass(/ig-cursor/);
  proc.stdin!.write(
    `${JSON.stringify({ type: "config_update", sessionId: 1, config: { animate: "0" } })}\n`,
  );

  // Full-graph fit beats the wheel's zoom floor: an 80-node chain in a
  // 500×300 window needs a scale far below d3-graphviz's default 0.1 lower
  // scaleExtent — Shift+F must relax the floor and land the ENTIRE graph
  // inside the window, not clamp and leave most of it off-screen.
  const chain = Array.from({ length: 80 }, (_, i) => `n${i}`).join(" -> ");
  proc.stdin!.write(
    `${JSON.stringify({
      type: "render",
      sessionId: 1,
      dot: `digraph { ${chain} }`,
      engine: "dot",
      v: 4,
    })}\n`,
  );
  await expect(page.locator("#app svg g.node")).toHaveCount(80, { timeout: 20_000 });
  await page.setViewportSize({ width: 500, height: 300 });
  await page.keyboard.press("Shift+F");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const r = document.querySelector("#app svg g.graph")!.getBoundingClientRect();
        return (
          r.left >= -1 &&
          r.top >= -1 &&
          r.right <= window.innerWidth + 1 &&
          r.bottom <= window.innerHeight + 1
        );
      }),
    )
    .toBe(true);
});
