import type {
  PermissionGrantFamily,
  PermissionGrantMutationResult,
  PermissionGrantMutationView,
  PermissionGrantRecord,
  PermissionGrantSnapshot,
  PermissionGrantView
} from '../../shared/permission-grants'
import { missingDefaultGlobalPermissionCapabilities } from './defaults'

type PermissionGrantNames = {
  projects?: ReadonlyMap<string, string>
  sessions?: ReadonlyMap<string, string>
  connectorPolicy?: ConnectorPolicySnapshot
}

type PermissionGrantProjectionMetadata = Pick<
  PermissionGrantSnapshot,
  'version' | 'incompleteStores'
>

type ConnectorPolicySnapshot = {
  bundledConnectorIds?: readonly string[]
  autoAllowIds?: readonly string[]
  blockedToolIds?: readonly string[]
  askToolIds?: readonly string[]
  disabledConnectorIds?: readonly string[]
  customMcpServers?: ReadonlyArray<{
    id: string
    name: string
    displayName: string
    enabled: boolean
    oauth?: unknown
    oauthState?: { tokens?: { access_token?: string } }
  }>
}

const CUSTOMIZE_LABELS: Readonly<Record<string, string>> = {
  'customize:agent_create': 'Create agent',
  'customize:agent_update': 'Update agent',
  'customize:skill_publish': 'Publish skill',
  'customize:skill_edit': 'Edit skill',
  'customize:agent_attach_skill': 'Attach skill',
  'customize:agent_detach_skill': 'Detach skill',
  'customize:agent_attach_connector': 'Attach connector',
  'customize:agent_detach_connector': 'Detach connector'
}

const titleFromKey = (key: string): string => {
  const leaf = key.split(/[/:]/).filter(Boolean).at(-1) ?? key
  return leaf
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/^./, (value) => value.toUpperCase())
}

const familyFor = (record: PermissionGrantRecord): PermissionGrantFamily => {
  switch (record.capability.kind) {
    case 'customize_mutation':
      return 'registry_writes'
    case 'execution':
      return 'local_compute'
    case 'mcp_tool':
      return 'connectors'
    case 'file_operation':
      return 'file_operations'
    case 'skill_operation':
      return 'skills'
    case 'builtin_tool':
      return 'built_in_tools'
  }
}

const capabilityLabelFor = (record: PermissionGrantRecord): string => {
  if (record.capability.kind === 'customize_mutation') {
    return CUSTOMIZE_LABELS[record.capability.key] ?? titleFromKey(record.capability.key)
  }
  return titleFromKey(record.capability.key)
}

const qualifierLabelFor = (record: PermissionGrantRecord): string | undefined => {
  const qualifier = record.capability.qualifier
  if (!qualifier) return undefined
  if (qualifier.mode === 'any') return 'Any call'
  if (qualifier.mode === 'exact') return 'Specific input'
  if (
    record.capability.kind === 'execution' &&
    qualifier.value.startsWith('argv-prefix:sha256:v1:')
  ) {
    return 'Command group'
  }
  return qualifier.value
}

const capabilityIdentity = (record: PermissionGrantRecord): string => {
  const qualifier = record.capability.qualifier
  return JSON.stringify([
    record.capability.kind,
    record.capability.key,
    qualifier?.mode ?? 'none',
    qualifier && qualifier.mode !== 'any' ? qualifier.value : null
  ])
}

const coveringScopeFor = (
  record: PermissionGrantRecord,
  records: PermissionGrantRecord[]
): 'global' | 'project' | undefined => {
  if (record.scope.kind === 'global') return undefined
  const identity = capabilityIdentity(record)
  const matching = records.filter(
    (candidate) => candidate.id !== record.id && capabilityIdentity(candidate) === identity
  )
  if (record.scope.kind === 'session') {
    const projectId = record.scope.projectId
    if (
      matching.some(
        (candidate) => candidate.scope.kind === 'project' && candidate.scope.projectId === projectId
      )
    ) {
      return 'project'
    }
  }
  return matching.some((candidate) => candidate.scope.kind === 'global') ? 'global' : undefined
}

const connectorProjection = (
  record: PermissionGrantRecord,
  policy: ConnectorPolicySnapshot | undefined
): Pick<
  PermissionGrantView,
  'connectorServerId' | 'connectorToolName' | 'effectiveState' | 'policyHint'
> => {
  if (record.capability.kind !== 'mcp_tool') return {}
  const match = /^mcp:([^/]+)\/(.+)$/.exec(record.capability.key)
  if (!match) return {}
  const [, serverId, toolName] = match
  const custom = policy?.customMcpServers?.find((server) => server.id === serverId)
  const isBundled = policy?.bundledConnectorIds?.includes(serverId) ?? false
  if (!custom && !isBundled) return {}
  const aliases = custom ? [custom.name] : [serverId]
  const hasToolPolicy = (entries: readonly string[] | undefined): boolean =>
    aliases.some((alias) => entries?.includes(`${alias}/${toolName}`)) ?? false
  const disabled = custom
    ? !custom.enabled || Boolean(custom.oauth && !custom.oauthState?.tokens?.access_token)
    : (policy?.disabledConnectorIds ?? []).includes(serverId)
  const blocked = disabled || hasToolPolicy(policy?.blockedToolIds)
  const covered =
    aliases.some((alias) => policy?.autoAllowIds?.includes(alias)) ||
    !hasToolPolicy(policy?.askToolIds)

  return {
    connectorServerId: serverId,
    connectorToolName: toolName,
    effectiveState: blocked ? 'blocked_by_policy' : covered ? 'covered_by_policy' : 'active',
    ...(blocked
      ? { policyHint: 'Blocked in Connectors; this permission is currently inactive' }
      : covered
        ? { policyHint: 'Allowed by Connector policy even without this permission' }
        : {})
  }
}

const projectGrantRecord = (
  record: PermissionGrantRecord,
  names: PermissionGrantNames,
  coveredBy?: 'global' | 'project'
): PermissionGrantView => {
  const scope = record.scope
  const projectName = scope.kind === 'global' ? undefined : names.projects?.get(scope.projectId)
  const sessionName = scope.kind === 'session' ? names.sessions?.get(scope.sessionId) : undefined
  const scopeLabel =
    scope.kind === 'global'
      ? 'Global'
      : scope.kind === 'project'
        ? `Project: ${projectName ?? 'Unknown project'}`
        : `Session: ${sessionName ?? 'Unknown session'}`

  return {
    id: record.id,
    revision: record.revision,
    family: familyFor(record),
    capabilityKind: record.capability.kind,
    capabilityLabel: capabilityLabelFor(record),
    ...(qualifierLabelFor(record) ? { qualifierLabel: qualifierLabelFor(record) } : {}),
    scopeKind: scope.kind,
    scopeLabel,
    ...(coveredBy ? { coveredBy } : {}),
    ...connectorProjection(record, names.connectorPolicy),
    ...(scope.kind === 'global' ? {} : { projectId: scope.projectId }),
    ...(scope.kind === 'session' ? { sessionId: scope.sessionId } : {}),
    ...(record.createdAt ? { createdAt: record.createdAt } : {})
  }
}

const projectPermissionGrantSnapshot = (
  records: PermissionGrantRecord[],
  names: PermissionGrantNames = {},
  metadata: PermissionGrantProjectionMetadata = { version: 0, incompleteStores: [] }
): PermissionGrantSnapshot => {
  const grants = records.map((record) =>
    projectGrantRecord(record, names, coveringScopeFor(record, records))
  )
  return {
    ...metadata,
    missingDefaultGlobalGrantCount: missingDefaultGlobalPermissionCapabilities(records).length,
    grants,
    counts: {
      all: grants.length,
      global: grants.filter((grant) => grant.scopeKind === 'global').length,
      project: grants.filter((grant) => grant.scopeKind === 'project').length,
      session: grants.filter((grant) => grant.scopeKind === 'session').length
    }
  }
}

const projectPermissionGrantMutation = (
  result: PermissionGrantMutationResult,
  names: PermissionGrantNames = {},
  metadata: PermissionGrantProjectionMetadata = { version: 0, incompleteStores: [] }
): PermissionGrantMutationView => ({
  ...projectPermissionGrantSnapshot(result.grants, names, metadata),
  ...(result.receipt ? { receipt: result.receipt } : {}),
  conflicts: result.conflicts
})

export { projectPermissionGrantMutation, projectPermissionGrantSnapshot }
export type { ConnectorPolicySnapshot, PermissionGrantNames, PermissionGrantProjectionMetadata }
