import { defineConfig } from "@playwright/test";

// Cross-browser harness for the cursor-glow surface (the gap that let the
// v0.12.0 Safari/Firefox/Chrome glow bugs ship — CI's playwright.config.ts is
// chromium-only by design). Not run in CI: run it locally when touching the
// glow filter, bloom animation, or emphasis CSS:
//
//   npx playwright install webkit firefox   # once
//   IG_GLOW_VISUAL=1 node_modules/.bin/playwright test \
//     --config playwright.cross.config.ts
//
// Runs BOTH spec files per engine: smoke.spec.ts (the full behavior pass,
// including the chromium-phase-sync leg) and glow-visual.spec.ts (rendered
// glow pixels + CPU sampling; gated behind IG_GLOW_VISUAL).
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  projects: [
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
