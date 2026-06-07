-- Minimal busted-compatible shim so pure-Lua specs (those that stub _G.vim and
-- need no real Neovim) can run under the plain `lua` interpreter when the busted
-- CLI is unavailable locally. CI remains the canonical busted gate; this only
-- mirrors a subset of the API the specs in this repo actually use.

local M = {}

local function deep_equal(a, b)
  if a == b then
    return true
  end
  if type(a) ~= "table" or type(b) ~= "table" then
    return false
  end
  for k, v in pairs(a) do
    if not deep_equal(v, b[k]) then
      return false
    end
  end
  for k in pairs(b) do
    if a[k] == nil then
      return false
    end
  end
  return true
end

local function fail(msg)
  error(msg, 2)
end

-- assert table with the busted-style fluent helpers used in this repo.
local assert_mt = {}
assert_mt.__index = assert_mt

local function build_assert()
  local a = {}

  a.are = {
    equal = function(expected, actual)
      if expected ~= actual then
        fail(("expected %s, got %s"):format(tostring(expected), tostring(actual)))
      end
    end,
    same = function(expected, actual)
      if not deep_equal(expected, actual) then
        fail("tables not deeply equal")
      end
    end,
  }
  a.are_not = {
    equal = function(expected, actual)
      if expected == actual then
        fail(("expected values to differ, both %s"):format(tostring(actual)))
      end
    end,
  }
  a.is_true = function(v)
    if v ~= true then
      fail("expected true, got " .. tostring(v))
    end
  end
  a.is_false = function(v)
    if v ~= false then
      fail("expected false, got " .. tostring(v))
    end
  end
  a.is_nil = function(v)
    if v ~= nil then
      fail("expected nil, got " .. tostring(v))
    end
  end
  a.is_truthy = function(v)
    if not v then
      fail("expected truthy, got " .. tostring(v))
    end
  end
  -- busted aliases used by the specs in this repo.
  a.truthy = a.is_truthy
  a.is_not_nil = function(v)
    if v == nil then
      fail("expected non-nil value, got nil")
    end
  end
  a.has_error = function(fn, expected)
    local ok, err = pcall(fn)
    if ok then
      fail("expected function to error but it did not")
    end
    if expected ~= nil and tostring(err) ~= expected then
      -- busted matches on the error message string.
      fail(
        ("error message mismatch:\n  expected: %s\n  got:      %s"):format(expected, tostring(err))
      )
    end
  end

  -- busted's `assert` is also callable like the stdlib assert(v, msg).
  return setmetatable(a, {
    __call = function(_, v, msg)
      if not v then
        fail(msg or "assertion failed!")
      end
      return v
    end,
  })
end

function M.install()
  local stats = { pass = 0, fail = 0, failures = {} }
  local before_stack = {}
  local after_stack = {}

  _G.assert = build_assert()

  function _G.describe(_name, fn)
    fn()
  end

  function _G.before_each(fn)
    before_stack[#before_stack + 1] = fn
  end

  function _G.after_each(fn)
    after_stack[#after_stack + 1] = fn
  end

  function _G.it(name, fn)
    for _, b in ipairs(before_stack) do
      b()
    end
    local ok, err = xpcall(fn, debug.traceback)
    for _, af in ipairs(after_stack) do
      pcall(af)
    end
    if ok then
      stats.pass = stats.pass + 1
      io.write("  ok  - " .. name .. "\n")
    else
      stats.fail = stats.fail + 1
      stats.failures[#stats.failures + 1] = { name = name, err = err }
      io.write("  FAIL- " .. name .. "\n")
    end
  end

  -- describe blocks register their own before/after; reset per top-level file is
  -- not needed here because each spec scopes its own state via after_each.
  M._stats = stats
  return stats
end

function M.report()
  local stats = M._stats
  io.write(("\n%d passed, %d failed\n"):format(stats.pass, stats.fail))
  for _, f in ipairs(stats.failures) do
    io.write("\nFAILED: " .. f.name .. "\n" .. tostring(f.err) .. "\n")
  end
  return stats.fail == 0
end

return M
