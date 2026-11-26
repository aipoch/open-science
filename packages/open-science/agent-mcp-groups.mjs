/* eslint-disable @typescript-eslint/explicit-function-return-type */

// MCP grouping is an exposure concern. The Agent Adapter keeps the capability's
// business group (discovery, setup, research, delivery or literature); this
// registry maps those shared definitions to the three public MCP servers.
const definitions = {
  core: {
    id: 'core',
    serverName: 'open-science-core',
    capabilityGroups: ['discovery', 'setup', 'delivery'],
    dependsOn: []
  },
  research: {
    id: 'research',
    serverName: 'open-science-research',
    capabilityGroups: ['research'],
    dependsOn: ['core']
  },
  literature: {
    id: 'literature',
    serverName: 'open-science-literature',
    capabilityGroups: ['literature'],
    dependsOn: ['research']
  }
}

export const MCP_GROUP_IDS = Object.freeze(Object.keys(definitions))

export const MCP_GROUPS = Object.freeze(
  Object.fromEntries(
    MCP_GROUP_IDS.map((id) => [
      id,
      Object.freeze({
        ...definitions[id],
        capabilityGroups: Object.freeze([...definitions[id].capabilityGroups]),
        dependsOn: Object.freeze([...definitions[id].dependsOn])
      })
    ])
  )
)

export const isMcpGroup = (value) => typeof value === 'string' && MCP_GROUP_IDS.includes(value)

export const getMcpGroup = (group) => {
  if (group === undefined) return undefined
  if (!isMcpGroup(group)) throw new Error(`Unknown MCP group: ${group}`)
  return MCP_GROUPS[group]
}

export const mcpGroupForCapability = (entry) => {
  const match = MCP_GROUP_IDS.find((id) => MCP_GROUPS[id].capabilityGroups.includes(entry.group))
  return match
}

export const capabilityBelongsToMcpGroup = (entry, group) => {
  const definition = getMcpGroup(group)
  return Boolean(definition?.capabilityGroups.includes(entry.group))
}

export const mcpServerName = (group) => getMcpGroup(group)?.serverName ?? 'open-science'

export const defaultMcpServerConfig = ({
  command = 'npx',
  packageSpec = '@aipoch/open-science@latest'
} = {}) =>
  Object.fromEntries(
    MCP_GROUP_IDS.map((group) => [
      mcpServerName(group),
      {
        command,
        args:
          command === 'cmd.exe'
            ? ['/d', '/c', 'npx', '--yes', packageSpec, 'mcp', '--group', group]
            : [...(command === 'npx' ? ['--yes'] : []), packageSpec, 'mcp', '--group', group]
      }
    ])
  )
