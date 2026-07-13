if vim.g.loaded_interactive_graphviz == 1 then
  return
end
vim.g.loaded_interactive_graphviz = 1

local function dispatch(name, opts)
  require("interactive-graphviz.commands")[name](opts or {})
end

vim.api.nvim_create_user_command("GraphvizPreview", function(opts)
  dispatch("preview", opts)
end, {})

vim.api.nvim_create_user_command("GraphvizPreviewStop", function(opts)
  dispatch("stop", opts)
end, {})

vim.api.nvim_create_user_command("GraphvizPreviewToggle", function(opts)
  dispatch("toggle", opts)
end, {})

vim.api.nvim_create_user_command("GraphvizUrl", function(opts)
  dispatch("url", opts)
end, {})

vim.api.nvim_create_user_command("GraphvizCursorHighlightToggle", function(opts)
  dispatch("toggle_cursor_highlight", opts)
end, {})

vim.api.nvim_create_user_command("GraphvizJumpOnClickToggle", function(opts)
  dispatch("toggle_jump_on_click", opts)
end, {})

vim.api.nvim_create_user_command("GraphvizEngine", function(opts)
  dispatch("engine", opts)
end, {
  nargs = "?",
  complete = function()
    local engines = require("interactive-graphviz.config").get().engines or {}
    return vim.tbl_filter(function(engine)
      return type(engine) == "string"
    end, engines)
  end,
})
