import { afterEach, describe, expect, test } from "bun:test";
import { getAnimate, setAnimate } from "./animate";
import { _resetHighlightMode, getHighlightMode, setHighlightMode } from "./interact";
import { getSearchConfig, _resetSearchConfig, setSearchConfig } from "./search";
import { applyUrlConfig } from "./urlconfig";
import { getPreserveView, setPreserveView } from "./viewstate";

// Cross-boundary contract test (Story 6.1; closes the deferred-work Lua↔TS
// config-contract item, deferred-work.md).
//
// The interactivity config travels Lua → browser as URL query params on the
// preview URL. `commands.lua` (Lua) EMITS them; `urlconfig.ts` (TS) PARSES them;
// each side's own suite asserts only its own copy. A rename/typo on either side
// keeps both suites green while config silently stops applying — an absent param is
// indistinguishable from a default by design. This test is the shared source of
// truth across the boundary: it asserts both files reference the SAME literal param
// names, and that the Lua-side defaults encode the documented contract values. The
// TS-side default *values* are asserted in urlconfig.test.ts.

const REPO = `${import.meta.dir}/..`;
const COMMANDS_LUA = `${REPO}/lua/interactive-graphviz/commands.lua`;
const CONFIG_LUA = `${REPO}/lua/interactive-graphviz/config.lua`;
const URLCONFIG_TS = `${import.meta.dir}/urlconfig.ts`;

// The 6 config-derived params. `sessionId` + `token` are runtime values (emitted by
// commands.lua, read by ws.ts) — not part of the config contract, so excluded.
const CONFIG_PARAMS = [
  "preserve_view",
  "highlight_mode",
  "animate",
  "search_scope",
  "search_case",
  "search_regex",
].sort();

const read = (path: string): Promise<string> => Bun.file(path).text();

function luaBool(config: string, key: string): boolean {
  const match = new RegExp(`${key}\\s*=\\s*(true|false)`).exec(config);
  if (!match) throw new Error(`missing Lua boolean default: ${key}`);
  return match[1] === "true";
}

function luaString(config: string, key: string): string {
  const match = new RegExp(`${key}\\s*=\\s*"([^"]+)"`).exec(config);
  if (!match) throw new Error(`missing Lua string default: ${key}`);
  return match[1]!;
}

const b01 = (value: boolean): string => (value ? "1" : "0");

afterEach(() => {
  setPreserveView(true);
  _resetHighlightMode();
  setAnimate(true);
  _resetSearchConfig();
});

describe("Lua <-> TS URL-param contract", () => {
  test("commands.lua and urlconfig.ts reference the same config param names", async () => {
    const commands = await read(COMMANDS_LUA);
    const urlconfig = await read(URLCONFIG_TS);

    // Lua side: every `?name=%d` / `&name=%s` token in the URL format string,
    // minus the runtime params sessionId/token.
    const luaEmitted = new Set<string>();
    for (const m of commands.matchAll(/[?&]([a-zA-Z_]+)=%[sd]/g)) {
      luaEmitted.add(m[1]!);
    }
    luaEmitted.delete("sessionId");
    luaEmitted.delete("token");

    // TS side: every params.get("name") in urlconfig.ts.
    const tsParsed = new Set<string>();
    for (const m of urlconfig.matchAll(/params\.get\("([a-zA-Z_]+)"\)/g)) {
      tsParsed.add(m[1]!);
    }

    expect([...luaEmitted].sort()).toEqual(CONFIG_PARAMS);
    expect([...tsParsed].sort()).toEqual(CONFIG_PARAMS);
    // Transitive: the two boundaries agree with each other — the actual blind spot.
    expect([...luaEmitted].sort()).toEqual([...tsParsed].sort());
  });

  test("config.lua defaults resolve to the same frontend defaults via urlconfig.ts", async () => {
    const config = await read(CONFIG_LUA);
    const luaDefaults = {
      preserveView: luaBool(config, "preserve_view"),
      highlightMode: luaString(config, "highlight_mode"),
      animate: luaBool(config, "animate"),
      search: {
        scope: luaString(config, "scope"),
        caseSensitive: luaBool(config, "case_sensitive"),
        regex: luaBool(config, "regex"),
      },
    };

    // Start from non-default frontend state so this proves urlconfig.ts parses and
    // applies the Lua-emitted defaults, not merely that both modules start clean.
    setPreserveView(false);
    setHighlightMode("upstream");
    setAnimate(false);
    setSearchConfig({ scope: "nodes", caseSensitive: true, regex: true });

    applyUrlConfig(
      `?preserve_view=${b01(luaDefaults.preserveView)}&highlight_mode=${luaDefaults.highlightMode}` +
        `&animate=${b01(luaDefaults.animate)}&search_scope=${luaDefaults.search.scope}` +
        `&search_case=${b01(luaDefaults.search.caseSensitive)}&search_regex=${b01(luaDefaults.search.regex)}`,
    );

    expect(getPreserveView()).toBe(luaDefaults.preserveView);
    expect(getHighlightMode()).toBe(luaDefaults.highlightMode);
    expect(getAnimate()).toBe(luaDefaults.animate);
    expect(getSearchConfig()).toEqual(luaDefaults.search);
  });
});
