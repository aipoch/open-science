import type { PrismaClient } from '@prisma/client'

import type { PermissionCapability, PermissionGrantRecord } from '../../shared/permission-grants'
import type { PermissionGrantRegistry } from './registry'

// Keep the original marker so extending this list affects new installations only.
const DEFAULT_PERMISSION_GRANT_SEED_ID = 'global-customize-v1'

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

const DEFAULT_GLOBAL_PERMISSION_CAPABILITIES: readonly PermissionCapability[] = [
  ...DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS.map((key) => ({
    kind: 'customize_mutation' as const,
    key
  })),
  { kind: 'skill_operation', key: 'skill:invoke' },
  { kind: 'mcp_tool', key: 'mcp:open-science-literature/read_document' }
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
  const applied = await client.permissionGrantSeed.findUnique({
    where: { id: DEFAULT_PERMISSION_GRANT_SEED_ID },
    select: { id: true }
  })
  if (applied) return

  for (const capability of DEFAULT_GLOBAL_PERMISSION_CAPABILITIES) {
    await registry.remember({ capability, scope: { kind: 'global' } })
  }

  await client.permissionGrantSeed.upsert({
    where: { id: DEFAULT_PERMISSION_GRANT_SEED_ID },
    update: {},
    create: { id: DEFAULT_PERMISSION_GRANT_SEED_ID, appliedAt: new Date() }
  })
}

export {
  DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS,
  DEFAULT_GLOBAL_PERMISSION_CAPABILITIES,
  missingDefaultGlobalPermissionCapabilities,
  restoreDefaultPermissionGrants,
  seedDefaultPermissionGrants
}
