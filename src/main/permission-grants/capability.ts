import { createHash } from 'node:crypto'

import type { PermissionCapability } from '../../shared/permission-grants'
import { isPreRegisteredPermissionIdentity } from './identity-catalog'

const NOTEBOOK_RUNTIME_QUALIFIERS = new Set(['python', 'r', 'javascript', 'bash'])
const FILE_OPERATION_KEYS: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'notebook_edit',
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move'
}
const TRUSTED_TOOL_CATEGORIES: Readonly<Record<string, string>> = {
  agent_create: 'customize:agent_create',
  create_agent: 'customize:agent_create',
  agent_update: 'customize:agent_update',
  update_agent: 'customize:agent_update',
  skill_publish: 'customize:skill_publish',
  publish_skill: 'customize:skill_publish',
  skill_edit: 'customize:skill_edit',
  edit_skill: 'customize:skill_edit',
  agent_attach_skill: 'customize:agent_attach_skill',
  attach_skill: 'customize:agent_attach_skill',
  agent_detach_skill: 'customize:agent_detach_skill',
  detach_skill: 'customize:agent_detach_skill',
  agent_attach_connector: 'customize:agent_attach_connector',
  attach_connector: 'customize:agent_attach_connector',
  agent_detach_connector: 'customize:agent_detach_connector',
  detach_connector: 'customize:agent_detach_connector',
  local_exec_python: 'local_exec:python',
  local_python: 'local_exec:python',
  python_exec: 'local_exec:python',
  local_exec_bash: 'local_exec:bash',
  local_bash: 'local_exec:bash',
  bash_exec: 'local_exec:bash'
}
// Persisting an exact command is safe only when the input itself is not credential-bearing. The
// digest protects display/storage privacy; it does not make a secret reusable authority.
const SECRET_BEARING_INPUT_PATTERNS = [
  /\b(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-amz-security-token|cookie)\s*:/i,
  /\b_?[a-z0-9_-]*(?:auth(?:entication)?(?:[_-]?(?:key|token))?|access[_-]?token|api[_-]?key|bearer[_-]?token|client[_-]?secret|private[_-]?key|secret(?:[_-]?access[_-]?key)?|token|password|passphrase|passwd|credential)s?\s*=/i,
  /\b[a-z0-9_.-]*(?:secret[-_]?access[-_]?key|access[-_]?key(?:[-_]?id)?|session[-_]?token|security[-_]?token)[ \t]+['"]?[^\s'"]+/i,
  /(?:^|[ \t'"])--?(?:[a-z0-9]+[-_])*(?:access[-_]?(?:key|token)|api[-_]?key|auth[-_]?token|authorization|bearer(?:[-_]?token)?|client[-_]?secret|cookie|credentials?|pass|passphrase|passwd|password|pat|private[-_]?key|secret(?:[-_]?access[-_]?key)?|tokens?)(?:[-_]?(?:file|path))?(?:=|:|[ \t]+)/i,
  /(?:^|[ \t'"])--?key[-_]?(?:file|path)(?:=|:|[ \t]+)/i,
  /\b[A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD|PASSPHRASE|PASSWD|CREDENTIALS?|PAT|ACCESS_KEY(?:_ID)?|SECRET_ACCESS_KEY|CLIENT_SECRET|PRIVATE_KEY)\s*=/,
  /(?:^|\s)(?:-u|--(?:proxy-)?user)(?:=|\s+)['"]?[^\s:'"]+:[^\s'"]+/i,
  /\bcurl(?:\.exe)?\b[^\r\n]*?[ \t]-u=?['"]?[^\s:'"]+:[^\s'"]+/i,
  // Short flags are overloaded across CLIs, so reject only credential-bearing meanings for the
  // command that owns them instead of making every -a, -b, or -p command Once-only.
  /\b[Cc][Uu][Rr][Ll](?:\.[Ee][Xx][Ee])?\b[^\r\n]*?[ \t]-b(?:=?['"]?[^\s'"]+|[ \t]+['"]?[^\s'"]+)/,
  /\b[Dd][Oo][Cc][Kk][Ee][Rr](?:\.[Ee][Xx][Ee])?\b[^\r\n]*?\blogin\b[^\r\n]*?[ \t]-p(?:=?['"]?[^\s'"]+|[ \t]+['"]?[^\s'"]+)/,
  /\b[Ss][Ss][Hh][Pp][Aa][Ss][Ss](?:\.[Ee][Xx][Ee])?\b[^\r\n]*?[ \t]-p(?:=?['"]?[^\s'"]+|[ \t]+['"]?[^\s'"]+)/,
  /\b[Rr][Ee][Dd][Ii][Ss]-[Cc][Ll][Ii](?:\.[Ee][Xx][Ee])?\b[^\r\n]*?[ \t]-a(?:=?['"]?[^\s'"]+|[ \t]+['"]?[^\s'"]+)/,
  /\b(?:[Mm][Yy][Ss][Qq][Ll]|[Mm][Yy][Ss][Qq][Ll][Dd][Uu][Mm][Pp])(?:\.[Ee][Xx][Ee])?\b[^\r\n]*?[ \t]-p=?['"]?[^\s'"]+/,
  /\b(?:github_pat_|gh[pousr]_|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,})[A-Za-z0-9_-]*/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /[?&](?:token|access_token|api_key|key|secret|password|signature)=[^&#\s]+/i
] as const

const PERSISTABLE_GIT_SUBCOMMANDS = new Set(['status'])
const COMMAND_PREFIX_QUALIFIER_PATTERN = /^argv-prefix:sha256:v1:[a-f0-9]{64}$/

const containsSecretBearingMaterial = (value: string): boolean =>
  SECRET_BEARING_INPUT_PATTERNS.some((pattern) => pattern.test(value))

// Command groups retain only a digest of Codex's structured argv prefix. The category qualifier
// distinguishes them from exact full-command grants without persisting command arguments.
const commandPrefixPermissionCategory = (value: unknown): string | undefined => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (token): token is string =>
        typeof token === 'string' &&
        token.length > 0 &&
        [...token].every((character) => {
          const codePoint = character.codePointAt(0)
          return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f
        })
    )
  ) {
    return undefined
  }

  if (containsSecretBearingMaterial(value.join(' '))) return undefined

  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex')
  return `shell-group:argv-prefix:sha256:v1:${digest}`
}

// Exact-command memory is deliberately opt-in. A command digest proves only that the command text is
// unchanged; it cannot prove that a referenced script or local executable still has the same content.
// V1 therefore persists only commands whose safety is independent of mutable workspace files. Every
// interpreter, test runner, and shell-script invocation remains provider Once-only.
const isPersistableExactCommand = (command: string): boolean => {
  if (containsSecretBearingMaterial(command) || /[\r\n;&|<>`$\\'"=]/.test(command)) return false
  const tokens = command.replace(/^[ \t]+|[ \t]+$/gu, '').split(/[ \t]+/u)
  // Only the PATH-resolved system command is stable enough for V1. A path-qualified executable can
  // be replaced after approval while leaving the stored command digest unchanged.
  const executable = tokens.shift()
  if (executable !== 'git') return false

  const subcommand = tokens.shift()?.toLowerCase()
  return Boolean(subcommand && PERSISTABLE_GIT_SUBCOMMANDS.has(subcommand) && tokens.length === 0)
}

const exactPermissionQualifier = (value: string): { mode: 'exact'; value: string } => ({
  mode: 'exact',
  value: `sha256:v1:${createHash('sha256').update(value).digest('hex')}`
})

const normalizeTrustedToolName = (value: string): string =>
  value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()

const categoryFromTrustedToolName = (value: string | undefined): string | undefined =>
  value ? TRUSTED_TOOL_CATEGORIES[normalizeTrustedToolName(value)] : undefined

const capabilityFromLegacyCategory = (categoryKey: string): PermissionCapability | undefined => {
  if (categoryKey.startsWith('customize:')) {
    const key = categoryKey
    return isPreRegisteredPermissionIdentity('customize_mutation', key)
      ? { kind: 'customize_mutation', key }
      : undefined
  }

  if (categoryKey.startsWith('local_exec:')) {
    const key = `exec:local/${categoryKey.slice('local_exec:'.length)}`
    return isPreRegisteredPermissionIdentity('execution', key)
      ? { kind: 'execution', key, qualifier: { mode: 'any' } }
      : undefined
  }

  if (categoryKey.startsWith('shell:')) {
    const command = categoryKey.slice('shell:'.length)
    if (!command || !isPersistableExactCommand(command)) return undefined
    return {
      kind: 'execution',
      key: 'exec:agent/shell',
      qualifier: exactPermissionQualifier(command)
    }
  }

  if (categoryKey.startsWith('shell-group:')) {
    const qualifier = categoryKey.slice('shell-group:'.length)
    if (!COMMAND_PREFIX_QUALIFIER_PATTERN.test(qualifier)) return undefined
    return {
      kind: 'execution',
      key: 'exec:agent/shell',
      qualifier: { mode: 'category', value: qualifier }
    }
  }

  if (categoryKey.startsWith('mcp:')) {
    const descriptor = categoryKey.slice('mcp:'.length)
    const separator = descriptor.lastIndexOf(':')
    const possibleQualifier = separator >= 0 ? descriptor.slice(separator + 1) : undefined
    const hasRuntimeQualifier =
      possibleQualifier !== undefined && NOTEBOOK_RUNTIME_QUALIFIERS.has(possibleQualifier)
    const identity = hasRuntimeQualifier ? descriptor.slice(0, separator) : descriptor
    if (!identity.includes('/')) return undefined
    const key = `mcp:${identity}`
    if (
      identity.startsWith('open-science-') &&
      !isPreRegisteredPermissionIdentity('mcp_tool', key)
    ) {
      return undefined
    }
    return {
      kind: 'mcp_tool',
      key,
      ...(hasRuntimeQualifier
        ? { qualifier: { mode: 'category' as const, value: possibleQualifier } }
        : {})
    }
  }

  if (categoryKey === 'skill') {
    return { kind: 'skill_operation', key: 'skill:invoke' }
  }

  if (categoryKey.startsWith('file:')) {
    const operation = FILE_OPERATION_KEYS[categoryKey.slice('file:'.length)]
    return operation ? { kind: 'file_operation', key: `file:${operation}` } : undefined
  }

  // V1 has no persistable built-in provider tools. Unknown provider-native fallback names remain
  // Once-only until an explicit cross-framework Broker registration is added.
  return undefined
}

export {
  capabilityFromLegacyCategory,
  categoryFromTrustedToolName,
  commandPrefixPermissionCategory,
  containsSecretBearingMaterial,
  exactPermissionQualifier
}
