import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { ToolActivity } from '@/stores/session-store'

// The Skill runtime serves loads through its own MCP server; ACP providers namespace the tool as
// mcp__skills__load_skill (Claude), mcp.skills.load_skill (Codex), or a flattened underscore form.
const SKILL_LOAD_TOOL_PATTERN = /^(?:mcp__|mcp\.)?skills(?:__|\.|_)load_skill$/iu

// Providers project either the imperative ("Load skill: …") or the lifecycle ("Loading/Loaded
// skill: …") title variant; all three carry the canonical invocation name.
const SKILL_NAME_PATTERN = /^(?:load|loading|loaded)\s+skill:\s*(.+?)\s*$/iu

// load_skill results prepend the runtime-resolved package root before the SKILL.md document. The
// prefix is server-added transport context (and an absolute local path), never document content.
const SKILL_LOAD_BASE_DIRECTORY_PREFIX = /^Base directory for this skill: [^\n]*\r?\n\r?\n/u

// YAML frontmatter carries agent-facing metadata (name/description); both settings SKILL.md
// previews strip it before rendering, so the transcript document view does the same.
const YAML_FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u

// Detects the Skill runtime's load_skill MCP call by its stable namespaced tool identity.
const isSkillLoadActivity = (activity: ToolActivity): boolean =>
  SKILL_LOAD_TOOL_PATTERN.test(activity.providerToolName?.trim() ?? '') ||
  SKILL_LOAD_TOOL_PATTERN.test(activity.title.trim())

// Narrows unknown protocol extensions before reading provider-specific fields.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Projected lifecycle titles are the stable, user-safe Skill names shared across providers. The
// load_skill MCP call carries the canonical name in its `skill` argument instead (Codex keeps the
// real arguments inside a nested `arguments` envelope on completed activities).
const getLoadedSkillName = (activity: ToolActivity): string | undefined => {
  const titleName = SKILL_NAME_PATTERN.exec(activity.title)?.[1]?.trim()

  if (titleName) return titleName
  if (!isSkillLoadActivity(activity)) return undefined

  const rawInput = isRecord(activity.rawInput) ? activity.rawInput : undefined
  const args = rawInput && isRecord(rawInput.arguments) ? rawInput.arguments : rawInput
  const skillName = typeof args?.skill === 'string' ? args.skill.trim() : ''

  return skillName || undefined
}

// The permission card's counterpart to getLoadedSkillName: an approval request carries no
// projected lifecycle title, so detection leans on the broker-resolved mcpIdentity first
// (skills/load_skill) and falls back to the namespaced tool identity in providerToolName/title.
// The canonical skill name still comes from the `skill` argument, with the same Codex
// `arguments` envelope unwrap as the transcript path.
const getSkillLoadPermissionSkillName = (request: AcpPermissionRequest): string | undefined => {
  const isSkillLoad =
    request.mcpIdentity === 'skills/load_skill' ||
    SKILL_LOAD_TOOL_PATTERN.test(request.providerToolName?.trim() ?? '') ||
    SKILL_LOAD_TOOL_PATTERN.test(request.title.trim())

  if (!isSkillLoad) return undefined

  const rawInput = isRecord(request.rawInput) ? request.rawInput : undefined
  const args = rawInput && isRecord(rawInput.arguments) ? rawInput.arguments : rawInput
  const skillName = typeof args?.skill === 'string' ? args.skill.trim() : ''

  return skillName || undefined
}

// Extracts the renderable SKILL.md body from a load_skill output text: the base-directory prefix
// line and the YAML frontmatter block are removed. Returns nothing when the output is not a skill
// document (e.g. an error payload), so callers can fall back to the generic input/output view.
const extractSkillLoadDocument = (output: string): string | undefined => {
  if (!SKILL_LOAD_BASE_DIRECTORY_PREFIX.test(output)) return undefined

  const document = output
    .replace(SKILL_LOAD_BASE_DIRECTORY_PREFIX, '')
    .replace(YAML_FRONTMATTER_BLOCK, '')
    .trim()

  return document || undefined
}

export {
  extractSkillLoadDocument,
  getLoadedSkillName,
  getSkillLoadPermissionSkillName,
  isSkillLoadActivity
}
