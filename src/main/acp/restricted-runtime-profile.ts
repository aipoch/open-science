import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ResolvedAgentBackend } from '../agent-framework'
import { OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION } from '../skills/runtime-mcp-server'

type RestrictedRuntimeProfile = Readonly<{
  agentName: string
  description: string
  systemPrompt: string
  openCodePermissions: Readonly<Record<string, 'allow' | 'deny'>>
  steps?: number
  persistSession?: boolean
}>

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const removeClaudeSkillRuntimeCapability = (
  source: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> => {
  const sessionOptions = { ...source }
  const runtime = record(sessionOptions[OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION])
  delete sessionOptions[OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]
  if (typeof runtime.root !== 'string') return sessionOptions

  const withoutRuntimeRoot = (value: unknown): unknown[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const filtered = value.filter((entry) => entry !== runtime.root)
    return filtered.length > 0 ? filtered : undefined
  }
  const additionalDirectories = withoutRuntimeRoot(sessionOptions.additionalDirectories)
  if (additionalDirectories) sessionOptions.additionalDirectories = additionalDirectories
  else delete sessionOptions.additionalDirectories

  const sandbox = { ...record(sessionOptions.sandbox) }
  const filesystem = { ...record(sandbox.filesystem) }
  for (const key of ['allowRead', 'denyWrite'] as const) {
    const filtered = withoutRuntimeRoot(filesystem[key])
    if (filtered) filesystem[key] = filtered
    else delete filesystem[key]
  }
  if (Object.keys(filesystem).length > 0) sandbox.filesystem = filesystem
  else delete sandbox.filesystem
  if (Object.keys(sandbox).length > 0) sessionOptions.sandbox = sandbox
  else delete sessionOptions.sandbox
  return sessionOptions
}

const prepareOpenCodeBackend = async (
  backend: ResolvedAgentBackend,
  profileRoot: string,
  profile: RestrictedRuntimeProfile
): Promise<ResolvedAgentBackend> => {
  const configHome = join(profileRoot, 'opencode', 'config')
  const dataHome = join(profileRoot, 'opencode', 'data')
  const home = join(profileRoot, 'opencode', 'home')
  const configDir = join(configHome, 'opencode')
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataHome, { recursive: true }),
    mkdir(home, { recursive: true })
  ])
  const configured = record(JSON.parse(backend.env.OPENCODE_CONFIG_CONTENT ?? '{}'))
  const restricted = {
    ...configured,
    default_agent: profile.agentName,
    permission: profile.openCodePermissions,
    agent: {
      [profile.agentName]: {
        description: profile.description,
        mode: 'primary',
        ...(profile.steps === undefined ? {} : { steps: profile.steps }),
        permission: profile.openCodePermissions
      }
    }
  }
  await writeFile(join(configDir, 'opencode.json'), `${JSON.stringify(restricted, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  return {
    ...backend,
    env: {
      ...backend.env,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      OPENCODE_TEST_HOME: home,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(restricted)
    },
    systemPromptAppends: [profile.systemPrompt],
    persistentSystemPrompt: undefined
  }
}

const prepareCodexBackend = async (
  backend: ResolvedAgentBackend,
  profileRoot: string,
  profile: RestrictedRuntimeProfile
): Promise<ResolvedAgentBackend> => {
  const codexHome = join(profileRoot, 'codex')
  await mkdir(codexHome, { recursive: true })
  await writeFile(join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "ephemeral"\n', {
    encoding: 'utf8',
    mode: 0o600
  })
  const codexConfig = record(JSON.parse(backend.env.CODEX_CONFIG ?? '{}'))
  delete codexConfig.developer_instructions
  return {
    ...backend,
    env: { ...backend.env, CODEX_HOME: codexHome, CODEX_CONFIG: JSON.stringify(codexConfig) },
    systemPromptAppends: [profile.systemPrompt],
    persistentSystemPrompt: undefined
  }
}

const prepareClaudeBackend = async (
  backend: ResolvedAgentBackend,
  profileRoot: string,
  profile: RestrictedRuntimeProfile
): Promise<ResolvedAgentBackend> => {
  const env = { ...backend.env }
  const sessionOptions = removeClaudeSkillRuntimeCapability(backend.sessionOptions)
  // Token-authenticated Claude backends can move into this runtime's durable profile because the
  // credential is portable. claude-shared cannot: its OAuth state lives in the user's existing
  // CLAUDE_CONFIG_DIR, so keep that directory while asking the SDK to persist the Side chat there.
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) {
    env.CLAUDE_CONFIG_DIR = join(profileRoot, 'claude')
    await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true })
  }
  return {
    ...backend,
    env,
    sessionOptions: {
      ...sessionOptions,
      tools: [],
      skills: [],
      plugins: [],
      settings: {},
      settingSources: [],
      persistSession: profile.persistSession ?? false
    },
    systemPromptAppends: [profile.systemPrompt],
    persistentSystemPrompt: undefined
  }
}

const prepareRestrictedBackend = (
  backend: ResolvedAgentBackend,
  profileRoot: string,
  profile: RestrictedRuntimeProfile
): Promise<ResolvedAgentBackend> => {
  if (backend.framework.id === 'opencode') {
    return prepareOpenCodeBackend(backend, profileRoot, profile)
  }
  if (backend.framework.id === 'codex') return prepareCodexBackend(backend, profileRoot, profile)
  return prepareClaudeBackend(backend, profileRoot, profile)
}

export { prepareRestrictedBackend }
export type { RestrictedRuntimeProfile }
