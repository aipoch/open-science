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

const PERMISSION_GRANT_SEED_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "PermissionGrantSeed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appliedAt" DATETIME NOT NULL
);`

const seedDefaultPermissionGrants = async (
  registry: PermissionGrantRegistry,
  client: PrismaClient
): Promise<void> => {
  await client.$executeRawUnsafe(PERMISSION_GRANT_SEED_TABLE_DDL)
  const applied = await client.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT "id" FROM "PermissionGrantSeed" WHERE "id" = ? LIMIT 1',
    DEFAULT_PERMISSION_GRANT_SEED_ID
  )
  if (applied.length > 0) return

  for (const key of DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS) {
    const capability: PermissionCapability = { kind: 'customize_mutation', key }
    await registry.remember({ capability, scope: { kind: 'global' } })
  }

  await client.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "PermissionGrantSeed" ("id", "appliedAt") VALUES (?, ?)',
    DEFAULT_PERMISSION_GRANT_SEED_ID,
    new Date()
  )
}

export { DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS, seedDefaultPermissionGrants }
