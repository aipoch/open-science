import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { SkillRuntimeEnvironment as PackageEnvironment } from '@aipoch/skills/projection'
import { nodeRuntimeEnvironmentEntries } from '../node-process-host'
import {
  LOAD_SKILL_TOOL_NAME,
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION,
  SKILL_RUNTIME_ALLOWED_NAMES_ENV,
  SKILL_RUNTIME_DIRECTORY_ENV,
  SKILL_RUNTIME_MCP_SERVER_ARG,
  SKILL_RUNTIME_MCP_SERVER_NAME,
  SKILL_RUNTIME_ROOT_ENV
} from './runtime-mcp-constants'

export type SkillRuntimeMcpServerConfig = Readonly<{
  command: string
  entryPath: string
  root: string
  skillsDirectory?: string
  allowedNames?: readonly string[]
}>

export type SkillRuntimeEnvironment = Omit<PackageEnvironment, 'skillsDirectory'> & {
  skillsDirectory?: string
}

export const environmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): SkillRuntimeEnvironment => {
  const root = env[SKILL_RUNTIME_ROOT_ENV]
  if (!root || !isAbsolute(root)) throw new Error('Missing absolute Skill runtime root.')
  const serializedAllowedNames = env[SKILL_RUNTIME_ALLOWED_NAMES_ENV]
  const skillsDirectory = env[SKILL_RUNTIME_DIRECTORY_ENV]
  const directory = skillsDirectory ? { skillsDirectory } : {}
  if (!serializedAllowedNames) return { root, ...directory }
  const parsed = JSON.parse(serializedAllowedNames) as unknown
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== 'string')) {
    throw new Error('Invalid Skill runtime allowlist.')
  }
  return { root, ...directory, allowedNames: new Set(parsed) }
}

const skillRuntimeProcessEnvironment = ({
  root,
  skillsDirectory,
  allowedNames
}: Pick<SkillRuntimeMcpServerConfig, 'root' | 'skillsDirectory' | 'allowedNames'>): Record<
  string,
  string
> => ({
  ...Object.fromEntries(nodeRuntimeEnvironmentEntries().map(({ name, value }) => [name, value])),
  [SKILL_RUNTIME_ROOT_ENV]: root,
  ...(skillsDirectory ? { [SKILL_RUNTIME_DIRECTORY_ENV]: skillsDirectory } : {}),
  ...(allowedNames ? { [SKILL_RUNTIME_ALLOWED_NAMES_ENV]: JSON.stringify([...allowedNames]) } : {})
})

export const createSkillRuntimeMcpServerConfig = ({
  command,
  entryPath,
  ...environment
}: SkillRuntimeMcpServerConfig): Record<string, unknown> => ({
  type: 'stdio',
  command,
  args: [entryPath, SKILL_RUNTIME_MCP_SERVER_ARG],
  env: skillRuntimeProcessEnvironment(environment)
})

const ownedSkillRuntimeServers = new WeakMap<object, string>()
const skillServerFingerprint = (server: McpServer): string | undefined => {
  try {
    return createHash('sha256').update(JSON.stringify(server)).digest('hex')
  } catch {
    return undefined
  }
}

export const isOwnedSkillRuntimeAcpServer = (server: McpServer): boolean => {
  const expected = ownedSkillRuntimeServers.get(server)
  return expected !== undefined && skillServerFingerprint(server) === expected
}

export const inheritSkillRuntimeAcpServerOwnership = (source: McpServer, copy: McpServer): void => {
  if (!isOwnedSkillRuntimeAcpServer(source)) return
  const fingerprint = skillServerFingerprint(source)
  if (fingerprint && skillServerFingerprint(copy) === fingerprint) {
    ownedSkillRuntimeServers.set(copy, fingerprint)
  }
}

export const createSkillRuntimeAcpServerConfig = ({
  command,
  entryPath,
  ...environment
}: SkillRuntimeMcpServerConfig): McpServer & { args: string[] } => {
  const server: McpServer & { args: string[] } = {
    name: SKILL_RUNTIME_MCP_SERVER_NAME,
    command,
    args: [entryPath, SKILL_RUNTIME_MCP_SERVER_ARG],
    env: Object.entries(skillRuntimeProcessEnvironment(environment)).map(([name, value]) => ({
      name,
      value
    }))
  }
  const fingerprint = skillServerFingerprint(server)
  if (fingerprint !== undefined) ownedSkillRuntimeServers.set(server, fingerprint)
  return server
}

export const narrowSkillRuntimeAcpServers = (
  servers: readonly McpServer[],
  allowedNames: readonly string[] | undefined
): McpServer[] => {
  if (allowedNames === undefined) return [...servers]
  if (allowedNames.length === 0) {
    return servers.filter((server) => server.name !== SKILL_RUNTIME_MCP_SERVER_NAME)
  }
  const serialized = JSON.stringify([...new Set(allowedNames)])
  return servers.flatMap((server) => {
    if (server.name !== SKILL_RUNTIME_MCP_SERVER_NAME) return [server]
    if (!('env' in server)) return []
    return [
      {
        ...server,
        env: [
          ...(server.env ?? []).filter(({ name }) => name !== SKILL_RUNTIME_ALLOWED_NAMES_ENV),
          { name: SKILL_RUNTIME_ALLOWED_NAMES_ENV, value: serialized }
        ]
      }
    ]
  })
}

export { LOAD_SKILL_TOOL_NAME, OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION }
