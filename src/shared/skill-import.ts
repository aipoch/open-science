const SKILL_IMPORT_MCP_SERVER_NAME = 'open-science-skills'
const REQUEST_SKILL_IMPORT_TOOL_NAME = 'request_skill_import'
const REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION =
  'Open the application-owned preview and confirmation dialog for a Skill source the user explicitly asked to install. Pass exactly one source: github_url for a public GitHub Skill, or attachment_uri together with turn_token for an eligible .zip or .skill attachment. If the user provides only a Skill name or keywords, first use available web search to resolve an unambiguous github.com Skill directory or SKILL.md URL; ask the user to choose when multiple candidates remain. Never guess a URI, URL, or token. Nothing is written unless the user confirms.'

export {
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME
}
