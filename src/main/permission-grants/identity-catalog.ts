import type { PermissionCapabilityKind } from '../../shared/permission-grants'

// Closed v1 bootstrap catalog. Dynamic Connector, ComputeHost, and redacted exact-command identities
// are admitted only by their trusted runtime adapters and do not change this fixed inventory.
const PRE_REGISTERED_PERMISSION_IDENTITIES: Readonly<
  Record<PermissionCapabilityKind, readonly string[]>
> = {
  customize_mutation: [
    'customize:agent_create',
    'customize:agent_update',
    'customize:skill_publish',
    'customize:skill_edit',
    'customize:agent_attach_skill',
    'customize:agent_detach_skill',
    'customize:agent_attach_connector',
    'customize:agent_detach_connector'
  ],
  mcp_tool: [
    'mcp:open-science-notebook/ask_user_question',
    'mcp:open-science-notebook/notebook_execute',
    'mcp:open-science-notebook/repl_execute',
    'mcp:open-science-notebook/bash_execute',
    'mcp:open-science-notebook/notebook_state',
    'mcp:open-science-notebook/list_notebook_runtimes',
    'mcp:open-science-notebook/notebook_bind_runtime',
    'mcp:open-science-notebook/notebook_switch_runtime',
    'mcp:open-science-notebook/notebook_restart',
    'mcp:open-science-notebook/notebook_shutdown',
    'mcp:open-science-notebook/inspect_packages',
    'mcp:open-science-notebook/manage_packages',
    'mcp:open-science-notebook/manage_environments',
    'mcp:open-science-notebook/request_network_access',
    'mcp:open-science-artifacts/write_artifact_file',
    'mcp:open-science-activity/begin_activity_group',
    'mcp:open-science-skills/request_skill_import',
    'mcp:open-science-plan/generate_plan',
    'mcp:open-science-plan/update_step_status',
    'mcp:open-science-literature/read_document'
  ],
  execution: ['exec:local/python', 'exec:local/bash'],
  file_operation: [
    'file:read',
    'file:write',
    'file:edit',
    'file:notebook_edit',
    'file:delete',
    'file:move'
  ],
  skill_operation: ['skill:invoke'],
  builtin_tool: []
}

const PRE_REGISTERED_PERMISSION_IDENTITY_COUNT = Object.values(
  PRE_REGISTERED_PERMISSION_IDENTITIES
).reduce((count, identities) => count + identities.length, 0)

const isPreRegisteredPermissionIdentity = (kind: PermissionCapabilityKind, key: string): boolean =>
  PRE_REGISTERED_PERMISSION_IDENTITIES[kind].includes(key)

export {
  PRE_REGISTERED_PERMISSION_IDENTITIES,
  PRE_REGISTERED_PERMISSION_IDENTITY_COUNT,
  isPreRegisteredPermissionIdentity
}
