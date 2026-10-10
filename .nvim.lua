-- Loaded through trusted project-local configuration ('exrc').
local source = debug.getinfo(1, "S").source:sub(2)
local root = vim.fs.dirname(vim.fn.fnamemodify(source, ":p"))

vim.filetype.add({
  pattern = {
    [vim.pesc(root) .. "/.*%.toy"] = "toy",
    [vim.pesc(root) .. "/.*%.tpy"] = "toy",
  },
})

vim.lsp.config("toy", {
  cmd = { "node", root .. "/examples/toy-lsp.ts", "--stdio" },
  filetypes = { "toy" },
  workspace_required = true,
  root_dir = function(bufnr, on_dir)
    if vim.startswith(vim.api.nvim_buf_get_name(bufnr), root .. "/") then
      on_dir(root)
    end
  end,
})
vim.lsp.enable("toy")
