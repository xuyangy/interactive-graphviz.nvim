import { expect, test } from "@playwright/test";
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { isReady, type Ready } from "../../server/protocol";

// Cursor-glow VISUAL harness (opt-in: IG_GLOW_VISUAL=1) — asserts what the
// structural checks in smoke.spec.ts cannot: that the glow actually PAINTS.
// The v0.12.0 Safari bug passed every computed-style assertion (the CSS
// drop-shadow() was applied, WebKit just didn't rasterize it on SVG), and the
// v0.12.1 single-layer filter passed the url() checks while reading as a bare
// stroke pulse. So this spec samples real screenshot pixels beside an
// emphasized node and demands a cyan halo. It also re-runs the phase-desync
// recipe per engine and samples browser-process CPU while the bloom animates
// (the Firefox ~500% regression). Run via playwright.cross.config.ts; the
// default chromium CI config collects this file but skips it (env gate) —
// no server spawn, no cost.
const ENABLED = !!process.env.IG_GLOW_VISUAL;
test.skip(!ENABLED, "opt-in visual harness: set IG_GLOW_VISUAL=1");

const SERVER = fileURLToPath(new URL("../../server/server.ts", import.meta.url));

let proc: ChildProcess;
let ready: Ready;

test.beforeAll(async () => {
  if (!ENABLED) return;
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
        if (isReady(parsed) && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(parsed);
        }
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

// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced — what every Playwright
// engine emits) so the halo check reads REAL rasterized pixels with zero deps.
function decodePng(buf: Buffer): { width: number; height: number; bpp: number; px: Buffer } {
  let pos = 8; // signature
  let width = 0;
  let height = 0;
  let bpp = 4;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      const interlace = data[12];
      if (depth !== 8 || (color !== 6 && color !== 2) || interlace !== 0)
        throw new Error(`unsupported PNG: depth=${depth} color=${color} interlace=${interlace}`);
      bpp = color === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
  }
  return { width, height, bpp, px };
}

test("glow paints a real halo, endpoints bloom in phase, CPU stays sane", async ({
  page,
  browserName,
}) => {
  proc.stdin!.write(`${JSON.stringify({ type: "session_open", sessionId: 1 })}\n`);
  // Translucent fill on every node: the interior-alpha comparison below pins
  // the shadow-only merge law (a stacked shadow+source output densified
  // translucent fills under emphasis). Red, so it cannot contaminate the
  // blue-vs-red halo discriminator.
  proc.stdin!.write(
    `${JSON.stringify({
      type: "render",
      sessionId: 1,
      dot: 'digraph { node [style=filled fillcolor="#ff000033"]; a -> b; b -> c }',
      engine: "dot",
      v: 1,
    })}\n`,
  );
  // animate=1: the bloom needs html.ig-motion; the glow filter itself is
  // static, but we test the worst case — filter re-rasterized every frame.
  await page.goto(`http://127.0.0.1:${ready.port}/?sessionId=1&token=${ready.token}&animate=1`);
  await expect(page.locator("#app svg g.node")).toHaveCount(3, { timeout: 20_000 });
  // Wait for the initial fit transition to settle before measuring geometry.
  await page.waitForFunction(async () => {
    const el = document.querySelector("#app svg g.node");
    if (!el) return false;
    const before = JSON.stringify(el.getBoundingClientRect());
    await new Promise((r) => setTimeout(r, 200));
    return JSON.stringify(el.getBoundingClientRect()) === before;
  });

  // The exact v0.12.0 desync recipe: cursor on node b's line, half a bloom
  // cycle later onto edge b->c — b keeps its class (no animation restart)
  // while the edge + c match the rule fresh.
  proc.stdin!.write(`${JSON.stringify({ type: "emphasize", sessionId: 1, nodeId: "b" })}\n`);
  const nodeB = page.locator("g.node", { has: page.locator('title:text-is("b")') });
  await expect(nodeB).toHaveClass(/ig-cursor/);
  await page.waitForTimeout(600);
  proc.stdin!.write(`${JSON.stringify({ type: "emphasize", sessionId: 1, nodeId: "b->c" })}\n`);
  const nodeC = page.locator("g.node", { has: page.locator('title:text-is("c")') });
  const edgeBC = page.locator("g.edge", { has: page.locator('title:text-is("b->c")') });
  await expect(edgeBC).toHaveClass(/ig-cursor/);
  await expect(nodeC).toHaveClass(/ig-cursor/);

  // ── Phase sync (the "normally chrome" bug, asserted per engine) ──────────
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

  // ── The halo actually PAINTS (the Safari regression class) ───────────────
  // The edge emphasis pans the view toward the target (a d3 transition under
  // animate=1): wait for the geometry to settle so the rect measured below
  // still holds when the screenshot is taken.
  await page.waitForFunction(async () => {
    const el = document.querySelector("#app svg g.node");
    if (!el) return false;
    const before = JSON.stringify(el.getBoundingClientRect());
    await new Promise((r) => setTimeout(r, 200));
    return JSON.stringify(el.getBoundingClientRect()) === before;
  });
  // Sample a horizontal strip beside node b's ellipse — to the RIGHT, away
  // from the vertical dot-layout edge splines, so no other cyan geometry can
  // contaminate the strip. On the white light-theme canvas the #4fc3f7 halo
  // reads as blue≫red; the stroke itself ends ~3px past the geometry rect, so
  // hits beyond +4px are unambiguously the filter's halo, not the stroke.
  // For each ellipse: the halo-strip anchor (right edge midline) and an
  // interior sample point at (-w/4, -h/4) from center — inside the ellipse,
  // clear of the centered label text, and ~10px from the border so the
  // inward glow tail (~2% alpha) cannot skew the fill comparison.
  const measure = (el: Element) => {
    const r = el.getBoundingClientRect();
    return {
      right: r.right,
      cy: r.top + r.height / 2,
      ix: r.left + r.width / 4,
      iy: r.top + r.height / 4,
    };
  };
  const rect = await nodeB.locator("ellipse").first().evaluate(measure);
  const nodeA = page.locator("g.node", { has: page.locator('title:text-is("a")') });
  const rectA = await nodeA.locator("ellipse").first().evaluate(measure);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const shotBuf = await page.screenshot();
  if (process.env.IG_GLOW_SHOT_DIR)
    (await import("node:fs")).writeFileSync(
      `${process.env.IG_GLOW_SHOT_DIR}/spec-${browserName}.png`,
      shotBuf,
    );
  const shot = decodePng(shotBuf);
  const { bpp, px, width } = shot;
  const sample = (cssX: number, cssY: number) => {
    const x = Math.round(cssX * dpr);
    const y = Math.round(cssY * dpr);
    const o = (y * width + x) * bpp;
    return { r: px[o], g: px[o + 1], b: px[o + 2] };
  };
  let haloHits = 0;
  const strip: string[] = [];
  for (let dx = 2; dx <= 12; dx++) {
    const { r, g, b } = sample(rect.right + dx, rect.cy);
    strip.push(`+${dx}px rgb(${r},${g},${b})`);
    if (b - r > 25 && b > 150) haloHits++;
  }
  console.log(`[${browserName}] halo strip beside node b: ${strip.join("  ")}`);
  // v0.12.0 Safari (nothing painted): 0 hits (pure white, b-r = 0). v0.12.1
  // single faint σ2.5 layer: ~1-2 hits (indistinguishable from the 2px
  // stroke's own antialiasing tail). The σ4 3-stack halo on the near-native
  // stroke tints clearly to ~+7px — demand a real run of hits so
  // "technically nonzero" faintness keeps failing. Calibrated against the
  // ellipse's horizontal extremity, where the halo is at its THINNEST
  // (curvature puts less ink near the sample line than a straight edge).
  expect(haloHits).toBeGreaterThanOrEqual(4);

  // ── Translucent fills keep their alpha under emphasis ────────────────────
  // The glow merge must stack a SHADOW-ONLY result, with SourceGraphic
  // composited exactly once: a feDropShadow-style shadow+source output
  // stacked 3× rendered the original graphic 3× too — the alpha-0.2 red fill
  // densified to ≈0.49 (interior green/blue dropped ~74 points on white).
  // Compare the emphasized node b's interior against the unemphasized node
  // a's: same fill, so the channels must match within antialiasing noise.
  const aFill = sample(rectA.ix, rectA.iy);
  const bFill = sample(rect.ix, rect.iy);
  console.log(
    `[${browserName}] fill interior a rgb(${aFill.r},${aFill.g},${aFill.b}) vs emphasized b rgb(${bFill.r},${bFill.g},${bFill.b})`,
  );
  for (const ch of ["r", "g", "b"] as const) {
    expect(Math.abs(aFill[ch] - bFill[ch])).toBeLessThanOrEqual(30);
  }

  // ── CPU while the bloom animates (the Firefox ~500% regression) ──────────
  // ps %cpu on macOS is a decaying average: sample a few times and take the
  // MIN — a pathological per-frame re-blur pegs every sample, while startup
  // spikes decay out. Asserted for firefox (the regression engine), logged
  // for the rest.
  const engineRe = { firefox: /firefox/i, webkit: /webkit/i, chromium: /chrom/i }[
    browserName
  ] as RegExp;
  const samples: number[] = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1000);
    const out = execSync("ps -Ao %cpu=,command=", { encoding: "utf8" });
    const total = out
      .split("\n")
      .filter((l) => l.includes("ms-playwright") && engineRe.test(l))
      .reduce((s, l) => s + (Number.parseFloat(l.trim()) || 0), 0);
    samples.push(Math.round(total));
  }
  console.log(`[${browserName}] CPU samples while blooming (%): ${samples.join(", ")}`);
  if (browserName === "firefox") expect(Math.min(...samples)).toBeLessThan(250);

  proc.stdin!.write(`${JSON.stringify({ type: "emphasize", sessionId: 1, nodeId: null })}\n`);
  await expect(edgeBC).not.toHaveClass(/ig-cursor/);
});
