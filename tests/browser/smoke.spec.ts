import { expect, test } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real-browser smoke test — the ONLY automated coverage of the actual WASM
// layout/render path (everything else runs under happy-dom, which cannot
// execute Graphviz-WASM, d3-zoom gestures, or real rendering; see MEMORY
// browser-render-untested). Deliberately tiny by design: open the real
// preview, deliver one render through the real server, assert the toolbar,
// a real laid-out SVG, and one interaction. It guards user-visible behavior
// only — no module internals, no DOM ids beyond the stable public surfaces —
// so the planned render.ts refactor can move code without churning this test.

const SERVER = fileURLToPath(new URL("../../server/server.ts", import.meta.url));

interface Ready {
  type: string;
  port: number;
  token: string;
}

let proc: ChildProcess;
let ready: Ready;

// Spawn the real server (same entrypoint the Lua plugin runs) and read its
// ready{port,token} announcement — mirrors server/relay.test.ts's idiom.
test.beforeAll(async () => {
  proc = spawn("bun", ["run", SERVER], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, IG_HEARTBEAT_TIMEOUT_MS: "120000" },
  });
  ready = await new Promise<Ready>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server never announced ready")), 10_000);
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        resolve(JSON.parse(buf.slice(0, nl)) as Ready);
      }
    });
    proc.on("error", reject);
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
  proc.stdin!.write(
    `${JSON.stringify({
      type: "render",
      sessionId: 1,
      dot: "digraph { a -> b; b -> c }",
      engine: "dot",
      v: 1,
    })}\n`,
  );

  // animate=false is the real config param commands.lua would append for
  // setup{animate=false} — determinism for the click below (Playwright's
  // actionability check waits for a stable bounding box, and the d3 render
  // transition otherwise keeps the nodes in motion).
  await page.goto(
    `http://127.0.0.1:${ready.port}/?sessionId=1&token=${ready.token}&animate=false`,
  );

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
});
