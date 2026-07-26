const SKILL_IMPORT_MCP_SERVER_NAME = 'open-science-skills'
const REQUEST_SKILL_IMPORT_TOOL_NAME = 'request_skill_import'
const REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION =
  'Open the application-owned preview and confirmation dialog for an attached .zip or .skill package. Call only when the user explicitly asks to install or import that attachment. Pass the exact file URI from the attachment resource; never guess or construct a path. The application validates ownership and does not write anything unless the user confirms.'

export {
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME
}
