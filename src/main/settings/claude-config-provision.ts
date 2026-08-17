import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The app owns `<storageRoot>/claude` as a private Claude profile. Isolated/API-key providers use it
// as CLAUDE_CONFIG_DIR; shared auth keeps CLAUDE_CONFIG_DIR=~/.claude and loads only this settings
// file at session scope. Agent-readable Skills live in a separate runtime projection outside this
// directory so the private profile can remain protected as one physical security boundary.

// The agent's own file tools must not read (or search) the app config dir — it holds materialized
// provider/auth settings and session state whose contents must never be surfaced into conversation.
// Agent-readable Skill packages are deliberately projected outside this directory.
const GUARDED_FILE_TOOLS = ['Read', 'Edit', 'Glob', 'Grep'] as const

// Built-in agent tools disabled outright in this app. Empty by default: the model's open-web tools
// (WebSearch/WebFetch) are left enabled so the agent can reach the open web alongside the curated MCP
// research connectors. Add a tool name here to fence it out of the app-owned user scope.
//
// Tradeoff: #105 originally denied WebSearch as an exfiltration-channel hardening measure (open-web
// reach is a path for conversation/workspace data to leave the app). Re-opening it accepts that risk
// in exchange for the model's built-in web reach. Subscription WebFetch additionally relies on the
// CLI's claude.ai domain-safety preflight. Custom API-key sessions cannot reach that hard-coded check,
// so they force every WebFetch call through the app broker for explicit Once-only approval.
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

// Writes/merges `<configDir>/settings.json` for the app-owned runtime scope. Isolated providers load it
// as their user settings; shared mode injects it through the SDK's highest-priority settings option.
// Two things are enforced here, preserving unrelated settings already present: the permissions.deny
// guard rules (file-tool fence, plus the current DENIED_BUILTIN_TOOLS,
// after pruning any stale module-owned MANAGED_BUILTIN_TOOLS entries), and disableBundledSkills so
// Claude Code's own bundled skills/workflows (dataviz, deep-research, …) never leak in — the app
// injects its OWN curated skill set into `<configDir>/skills`, which disableBundledSkills leaves
// untouched.
export type ClaudeRuntimeModelConfig = Readonly<{
  availableModels: readonly string[]
  modelOverrides: Readonly<Record<string, string>>
}>

const writeAppSettings = async (
  configDir: string,
  modelConfig?: ClaudeRuntimeModelConfig | null
): Promise<Readonly<Record<string, unknown>>> => {
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
  if (modelConfig !== undefined) {
    if (modelConfig) {
      settings.availableModels = [...modelConfig.availableModels]
      settings.modelOverrides = { ...modelConfig.modelOverrides }
    } else {
      delete settings.availableModels
      delete settings.modelOverrides
    }
  }
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return settings
}

// Ensures the private app profile exists and merges the settings policy. It intentionally owns no
// plugin or Skill directories; those are published by claude-runtime-provisioner under the separate,
// Agent-readable runtime projection root.
const provisionAppClaudePrivateProfile = async (
  configDir: string,
  modelConfig?: ClaudeRuntimeModelConfig | null
): Promise<Readonly<Record<string, unknown>>> => {
  await mkdir(configDir, { recursive: true })
  return writeAppSettings(configDir, modelConfig)
}

export {
  DENIED_BUILTIN_TOOLS,
  MANAGED_BUILTIN_TOOLS,
  configDenyRules,
  provisionAppClaudePrivateProfile
}
