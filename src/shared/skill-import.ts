const SKILL_IMPORT_MCP_SERVER_NAME = 'open-science-skills'
const REQUEST_SKILL_IMPORT_TOOL_NAME = 'request_skill_import'
const REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION =
  'Open the application-owned preview and confirmation dialog for an attachment explicitly marked skillImportEligible. Call only when the user asks to install or import that eligible .zip or .skill package. Pass its exact file URI; never guess or construct a path. Ordinary ZIP attachments are not eligible. The application validates ownership and does not write anything unless the user confirms.'

export {
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME
}
