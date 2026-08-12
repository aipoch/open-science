import type { PrismaClient } from '@prisma/client'

import type { PermissionCapability } from '../../shared/permission-grants'
import type { PermissionGrantRegistry } from './registry'

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

const seedDefaultPermissionGrants = async (
  registry: PermissionGrantRegistry,
  client: PrismaClient
): Promise<void> => {
  const applied = await client.permissionGrantSeed.findUnique({
    where: { id: DEFAULT_PERMISSION_GRANT_SEED_ID },
    select: { id: true }
  })
  if (applied) return

  for (const key of DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS) {
    const capability: PermissionCapability = { kind: 'customize_mutation', key }
    await registry.remember({ capability, scope: { kind: 'global' } })
  }

  await client.permissionGrantSeed.upsert({
    where: { id: DEFAULT_PERMISSION_GRANT_SEED_ID },
    update: {},
    create: { id: DEFAULT_PERMISSION_GRANT_SEED_ID, appliedAt: new Date() }
  })
}

export { DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS, seedDefaultPermissionGrants }
