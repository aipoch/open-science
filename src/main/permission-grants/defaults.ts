import type { PrismaClient } from '@prisma/client'

import type { PermissionCapability, PermissionGrantRecord } from '../../shared/permission-grants'
import type { PermissionGrantRegistry } from './registry'

// Keep the original marker and capability set stable so upgrades do not restore
// legacy defaults that a user previously revoked.
const DEFAULT_PERMISSION_GRANT_SEED_ID = 'global-customize-v1'
const DEFAULT_LITERATURE_READ_PERMISSION_GRANT_SEED_ID = 'global-literature-read-v2'

const DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS = [
  'customize:agent_create',
  'customize:agent_update',
  'customize:skill_publish',
  'customize:skill_edit',
  'customize:agent_attach_skill',
  'customize:agent_detach_skill',
  'customize:agent_attach_connector',
  'customize:agent_detach_connector'
] as const

const LEGACY_DEFAULT_GLOBAL_PERMISSION_CAPABILITIES: readonly PermissionCapability[] = [
  ...DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS.map((key) => ({
    kind: 'customize_mutation' as const,
    key
  })),
  { kind: 'skill_operation', key: 'skill:invoke' },
  { kind: 'mcp_tool', key: 'mcp:open-science-literature/read_document' },
  { kind: 'mcp_tool', key: 'mcp:open-science-notebook/list_notebook_runtimes' },
  { kind: 'mcp_tool', key: 'mcp:open-science-notebook/notebook_state' },
  { kind: 'mcp_tool', key: 'mcp:open-science-notebook/list_memory_categories' },
  { kind: 'mcp_tool', key: 'mcp:open-science-notebook/search_memories' },
  { kind: 'mcp_tool', key: 'mcp:open-science-notebook/inspect_packages' },
  { kind: 'mcp_tool', key: 'mcp:open-science-plan/update_step_status' }
]

const DEFAULT_LITERATURE_READ_PERMISSION_CAPABILITIES: readonly PermissionCapability[] = [
  { kind: 'mcp_tool', key: 'mcp:open-science-library/search_library' },
  { kind: 'mcp_tool', key: 'mcp:open-science-library/read_library_abstract' },
  { kind: 'mcp_tool', key: 'mcp:open-science-library/read_library_pdf' },
  { kind: 'mcp_tool', key: 'mcp:open-science-library/format_references' }
]

const DEFAULT_GLOBAL_PERMISSION_CAPABILITIES: readonly PermissionCapability[] = [
  ...LEGACY_DEFAULT_GLOBAL_PERMISSION_CAPABILITIES,
  ...DEFAULT_LITERATURE_READ_PERMISSION_CAPABILITIES
]

const missingDefaultGlobalPermissionCapabilities = (
  grants: readonly PermissionGrantRecord[]
): readonly PermissionCapability[] =>
  DEFAULT_GLOBAL_PERMISSION_CAPABILITIES.filter(
    (defaultCapability) =>
      !grants.some(
        (grant) =>
          grant.scope.kind === 'global' &&
          !grant.capability.qualifier &&
          grant.capability.kind === defaultCapability.kind &&
          grant.capability.key === defaultCapability.key
      )
  )

const restoreDefaultPermissionGrants = async (
  registry: PermissionGrantRegistry
): Promise<number> => {
  const missing = missingDefaultGlobalPermissionCapabilities(await registry.list())

  for (const capability of missing) {
    await registry.remember({ capability, scope: { kind: 'global' } })
  }

  return missing.length
}

const seedDefaultPermissionGrants = async (
  registry: PermissionGrantRegistry,
  client: PrismaClient
): Promise<void> => {
  const applySeed = async (
    id: string,
    capabilities: readonly PermissionCapability[]
  ): Promise<void> => {
    const applied = await client.permissionGrantSeed.findUnique({
      where: { id },
      select: { id: true }
    })
    if (applied) return

    for (const capability of capabilities) {
      await registry.remember({ capability, scope: { kind: 'global' } })
    }

    await client.permissionGrantSeed.upsert({
      where: { id },
      update: {},
      create: { id, appliedAt: new Date() }
    })
  }

  await applySeed(DEFAULT_PERMISSION_GRANT_SEED_ID, LEGACY_DEFAULT_GLOBAL_PERMISSION_CAPABILITIES)
  await applySeed(
    DEFAULT_LITERATURE_READ_PERMISSION_GRANT_SEED_ID,
    DEFAULT_LITERATURE_READ_PERMISSION_CAPABILITIES
  )
}

export {
  DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS,
  DEFAULT_GLOBAL_PERMISSION_CAPABILITIES,
  DEFAULT_LITERATURE_READ_PERMISSION_CAPABILITIES,
  missingDefaultGlobalPermissionCapabilities,
  restoreDefaultPermissionGrants,
  seedDefaultPermissionGrants
}
