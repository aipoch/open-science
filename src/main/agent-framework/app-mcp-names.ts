import type { AgentFrameworkId } from './types'

type AppMcpServerDefinition = {
  canonicalName: string
  openCodeName: string
  tools: readonly string[]
}

// App-owned MCP identity stays canonical inside Open Science. Framework-specific names are projected
// only at the agent-facing seam so permissions, grants, policy, and diagnostics keep one stable key.
const APP_MCP_SERVERS: readonly AppMcpServerDefinition[] = [
  {
    canonicalName: 'open-science-activity',
    openCodeName: 'open_science_activity',
    tools: ['begin_activity_group']
  },
  {
    canonicalName: 'open-science-artifacts',
    openCodeName: 'open_science_artifacts',
    tools: ['write_artifact_file']
  },
  {
    canonicalName: 'open-science-notebook',
    openCodeName: 'open_science_notebook',
    tools: [
      'notebook_execute',
      'repl_execute',
      'bash_execute',
      'notebook_state',
      'list_notebook_runtimes',
      'notebook_bind_runtime',
      'notebook_switch_runtime',
      'notebook_restart',
      'notebook_shutdown',
      'inspect_packages',
      'manage_packages',
      'manage_environments'
    ]
  },
  {
    canonicalName: 'open-science-skills',
    openCodeName: 'open_science_skills',
    tools: ['request_skill_import']
  },
  {
    canonicalName: 'open-science-plan',
    openCodeName: 'open_science_plan',
    tools: ['generate_plan', 'update_step_status']
  }
]

const APP_MCP_SERVER_BY_CANONICAL_NAME = new Map(
  APP_MCP_SERVERS.map((definition) => [definition.canonicalName, definition])
)
const APP_MCP_SERVER_BY_OPENCODE_NAME = new Map(
  APP_MCP_SERVERS.map((definition) => [definition.openCodeName, definition])
)

const frameworkSafeMcpServerName = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, '_')

const canonicalAppMcpServerName = (name: string): string =>
  APP_MCP_SERVER_BY_OPENCODE_NAME.get(name)?.canonicalName ?? name

const modelFacingAppMcpServerName = (frameworkId: AgentFrameworkId, name: string): string => {
  const canonicalName = canonicalAppMcpServerName(name)
  const definition = APP_MCP_SERVER_BY_CANONICAL_NAME.get(canonicalName)

  return frameworkId === 'opencode' && definition ? definition.openCodeName : canonicalName
}

const appMcpServerAliases = (name: string): readonly string[] => {
  const canonicalName = canonicalAppMcpServerName(name)
  const definition = APP_MCP_SERVER_BY_CANONICAL_NAME.get(canonicalName)

  return [
    ...new Set(
      definition
        ? [definition.canonicalName, definition.openCodeName]
        : [canonicalName, frameworkSafeMcpServerName(canonicalName)]
    )
  ]
}

const resolveCanonicalMcpToolIdentity = (
  name: string | null | undefined,
  mcpServerNames: readonly string[]
): string | undefined => {
  if (!name) return undefined

  const canonicalServers = [
    ...new Set(mcpServerNames.map((server) => canonicalAppMcpServerName(server)))
  ]
  const configuredServerFor = (reportedServer: string): string | undefined => {
    const matches = canonicalServers.filter((server) =>
      appMcpServerAliases(server).includes(reportedServer)
    )
    return matches.length === 1 ? matches[0] : undefined
  }

  if (name.startsWith('mcp__')) {
    const [reportedServer, ...toolParts] = name.slice('mcp__'.length).split('__')
    if (!reportedServer || toolParts.length === 0) return undefined
    const server = configuredServerFor(reportedServer)
    if (!server) return undefined

    return `${server}/${toolParts.join('__')}`
  }

  const serverAliases = canonicalServers
    .flatMap((server) => appMcpServerAliases(server).map((alias) => ({ alias, server })))
    .sort((left, right) => right.alias.length - left.alias.length)

  for (const { alias, server } of serverAliases) {
    const codexPrefix = `mcp.${alias}.`
    if (name.startsWith(codexPrefix)) return `${server}/${name.slice(codexPrefix.length)}`

    const openCodePrefix = `${alias}_`
    if (name.startsWith(openCodePrefix)) return `${server}/${name.slice(openCodePrefix.length)}`
  }

  return undefined
}

const modelFacingAppMcpToolName = (
  frameworkId: AgentFrameworkId,
  server: string,
  tool: string,
  codexBridgeAliases = false
): string => {
  const canonicalServer = canonicalAppMcpServerName(server)
  if (frameworkId === 'codex' && !codexBridgeAliases) {
    return `mcp.${canonicalServer}.${tool}`
  }
  if (frameworkId === 'opencode') {
    return `${modelFacingAppMcpServerName(frameworkId, canonicalServer)}_${tool}`
  }

  return `mcp__${canonicalServer.replace(/[^a-zA-Z0-9_]/g, '_')}__${tool}`
}

const renderAppMcpToolReferences = (frameworkId: AgentFrameworkId, text: string): string => {
  if (frameworkId === 'codex') return text

  let rendered = text
  if (frameworkId === 'opencode') {
    for (const definition of APP_MCP_SERVERS) {
      rendered = rendered.replaceAll(definition.canonicalName, definition.openCodeName)
    }
  }

  for (const definition of APP_MCP_SERVERS) {
    for (const tool of definition.tools) {
      const callableName =
        frameworkId === 'claude-code'
          ? `mcp__${definition.canonicalName}__${tool}`
          : modelFacingAppMcpToolName(frameworkId, definition.canonicalName, tool)
      rendered = rendered.replace(new RegExp(`\\b${tool}\\b`, 'g'), callableName)
    }
  }

  return rendered
}

export {
  appMcpServerAliases,
  canonicalAppMcpServerName,
  modelFacingAppMcpServerName,
  modelFacingAppMcpToolName,
  resolveCanonicalMcpToolIdentity,
  renderAppMcpToolReferences
}
