import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeCodeSkillMaterializer, type SkillMaterializer } from '../skills/materializer'
import { SkillRegistry, type BundledSkill } from '../skills/registry'

// The app owns its Claude config directory (`<storageRoot>/claude`), shared by every provider and kept
// separate from the user's `~/.claude`. This module ensures that directory exists and injects the app's
// OWN skills before the agent spawns. It never reads from or copies anything out of ~/.claude.

// Subdirs claude loads app-scoped assets from. App-owned; never synced with ~/.claude.
const APP_ASSET_SUBDIRS = ['skills', 'plugins', 'commands'] as const

// The agent's own file tools must not read (or search) the app config dir — it holds the materialized
// skill files, whose (bundled / MCP) contents must never be surfaced verbatim into the conversation.
// Skill *loading* is internal to the agent and unaffected by these tool-level deny rules. The kernel
// (bash/subprocess) is guarded separately; see the notebook audit hook and read-guard spec.
const GUARDED_FILE_TOOLS = ['Read', 'Edit', 'Glob', 'Grep'] as const

// Built-in agent tools disabled outright in this app. Empty by default: the model's open-web tools
// (WebSearch/WebFetch) are left enabled so the agent can reach the open web alongside the curated MCP
// research connectors. Add a tool name here to fence it out of the app-owned user scope.
//
// Tradeoff: #105 originally denied WebSearch as an exfiltration-channel hardening measure (open-web
// reach is a path for conversation/workspace data to leave the app). Re-opening it accepts that risk
// in exchange for the model's built-in web reach. WebFetch additionally relies on the CLI's own
// claude.ai domain-safety preflight (enforced inside the claude binary, not here) as a backstop.
const DENIED_BUILTIN_TOOLS = [] as const

// Built-in tool deny entries this module OWNS across versions — the full set it has ever written into
// `permissions.deny`, regardless of what DENIED_BUILTIN_TOOLS currently holds. Provisioning prunes
// these from the existing file before re-adding the current DENIED_BUILTIN_TOOLS, so the deny list
// stays declarative (reflects present policy) instead of accumulating stale entries. Without this, a
// tool removed from DENIED_BUILTIN_TOOLS would stay denied forever on installs that once persisted it
// (e.g. WebSearch written by #105). Unrelated user/third-party deny rules are never touched.
const MANAGED_BUILTIN_TOOLS = ['WebSearch'] as const

// Builds the claude-code permission deny rules that fence the agent's file tools out of `configDir`.
// Claude Code permission paths are gitignore-style with forward slashes, where a `//<abs>` prefix
// denotes an absolute filesystem path. Normalize Windows backslashes and collapse the leading slash
// so both POSIX (`/Users/…` -> `//Users/…`) and Windows (`C:\…` -> `//C:/…`) yield the `//` form.
const configDenyRules = (configDir: string): string[] => {
  const abs = configDir.replace(/\\/g, '/').replace(/^\/+/, '')
  return GUARDED_FILE_TOOLS.map((tool) => `${tool}(//${abs}/**)`)
}

// Writes/merges `<configDir>/settings.json` for the app-owned user scope (the agent runs with
// settingSources: ['user']). Two things are enforced here, preserving unrelated settings already
// present: the permissions.deny guard rules (file-tool fence, plus the current DENIED_BUILTIN_TOOLS,
// after pruning any stale module-owned MANAGED_BUILTIN_TOOLS entries), and disableBundledSkills so
// Claude Code's own bundled skills/workflows (dataviz, deep-research, …) never leak in — the app
// injects its OWN curated skill set into `<configDir>/skills`, which disableBundledSkills leaves
// untouched.
const writeAppSettings = async (configDir: string): Promise<void> => {
  const settingsPath = join(configDir, 'settings.json')

  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null) settings = parsed as Record<string, unknown>
  } catch {
    settings = {}
  }

  const permissions =
    typeof settings.permissions === 'object' && settings.permissions !== null
      ? (settings.permissions as Record<string, unknown>)
      : {}
  const existingDeny = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : []
  // Drop any module-owned built-in deny entries first so a tool dropped from DENIED_BUILTIN_TOOLS is
  // actually re-enabled on upgrade, then re-add only the ones current policy still denies.
  const managed = new Set<string>(MANAGED_BUILTIN_TOOLS)
  const preservedDeny = existingDeny.filter((rule) => !managed.has(rule))
  const deny = [
    ...new Set([...preservedDeny, ...configDenyRules(configDir), ...DENIED_BUILTIN_TOOLS])
  ]

  settings.permissions = { ...permissions, deny }
  settings.disableBundledSkills = true
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

type ProvisionOptions = {
  // The full skill catalog (featured + imported + personal). Defaults to bundled skills only.
  skills?: BundledSkill[]
  materializer?: SkillMaterializer
  disabledSkillIds?: string[]
}

// Ensures the app config dir + asset subdirs exist, writes the file-tool deny rules, then materializes
// the enabled skill set into `<configDir>/skills`. Idempotent and safe to call before each agent spawn.
// Skill materialization failures are swallowed by the materializer so a bad skill never blocks the spawn.
const provisionAppClaudeConfigDir = async (
  configDir: string,
  options: ProvisionOptions = {}
): Promise<void> => {
  await mkdir(configDir, { recursive: true })
  await Promise.all(
    APP_ASSET_SUBDIRS.map((sub) => mkdir(join(configDir, sub), { recursive: true }))
  )

  await writeAppSettings(configDir)

  const materializer = options.materializer ?? new ClaudeCodeSkillMaterializer()
  const skills = options.skills ?? (await new SkillRegistry().list())
  const disabled = new Set(options.disabledSkillIds ?? [])
  const enabled = skills.filter((skill) => !disabled.has(skill.id))

  await materializer.sync(configDir, enabled)
}

export {
  APP_ASSET_SUBDIRS,
  DENIED_BUILTIN_TOOLS,
  MANAGED_BUILTIN_TOOLS,
  configDenyRules,
  provisionAppClaudeConfigDir
}
