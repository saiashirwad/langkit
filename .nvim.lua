-- Loaded through trusted project-local configuration ('exrc').
local source = debug.getinfo(1, "S").source:sub(2)
local root = vim.fs.dirname(vim.fn.fnamemodify(source, ":p"))

vim.filetype.add({
  pattern = {
    [vim.pesc(root) .. "/.*%.toy"] = "toy",
    [vim.pesc(root) .. "/.*%.tpy"] = "toy",
    [vim.pesc(root) .. "/.*%.hm"] = "hm",
    [vim.pesc(root) .. "/.*%.rows"] = "rows",
    [vim.pesc(root) .. "/.*%.advanced"] = "advanced",
    [vim.pesc(root) .. "/.*%.strict"] = "strict",
    [vim.pesc(root) .. "/.*%.schema"] = "schema",
    [vim.pesc(root) .. "/.*%.ur"] = "ur",
    [vim.pesc(root) .. "/.*%.shapes"] = "shapes",
  },
})

for _, language in ipairs({ "toy", "hm", "rows", "advanced", "strict", "schema", "ur", "shapes" }) do
  vim.lsp.config(language, {
    cmd = { "node", root .. "/examples/" .. language .. "/" .. language .. "-lsp.ts", "--stdio" },
    filetypes = { language },
    workspace_required = true,
    root_dir = function(bufnr, on_dir)
      if vim.startswith(vim.api.nvim_buf_get_name(bufnr), root .. "/") then
        on_dir(root)
      end
    end,
  })
  vim.lsp.enable(language)
end

vim.lsp.config("tsc", {
  before_init = function(params, config)
    if config.root_dir == root then
      params.initializationOptions = vim.tbl_extend("force", params.initializationOptions or {}, { runExternalCode = true })
    end
  end,
})
