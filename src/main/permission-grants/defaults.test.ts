import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import {
  DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS,
  DEFAULT_GLOBAL_PERMISSION_CAPABILITIES,
  seedDefaultPermissionGrants
} from './defaults'
import { PRE_REGISTERED_PERMISSION_IDENTITIES } from './identity-catalog'
import { createPermissionGrantRegistry, type PermissionGrantRegistry } from './registry'

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const setup = async (): Promise<{ client: PrismaClient; registry: PermissionGrantRegistry }> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-permission-defaults-'))
  client = createProjectDbClient(storageRoot)
  await migrateApplicationDatabase(client)
  const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
  return { client, registry }
}

describe('default permission grants', () => {
  it('seeds the registered new-install defaults globally', async () => {
    const fixture = await setup()

    await seedDefaultPermissionGrants(fixture.registry, fixture.client)

    expect(DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS).toEqual(
      PRE_REGISTERED_PERMISSION_IDENTITIES.customize_mutation
    )
    expect(DEFAULT_GLOBAL_PERMISSION_CAPABILITIES).toEqual([
      ...DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS.map((key) => ({
        kind: 'customize_mutation',
        key
      })),
      { kind: 'skill_operation', key: 'skill:invoke' },
      { kind: 'mcp_tool', key: 'mcp:open-science-literature/read_document' }
    ])
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.skill_operation).toContain('skill:invoke')
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toContain(
      'mcp:open-science-literature/read_document'
    )
    const grants = await fixture.registry.list()
    expect(grants).toHaveLength(DEFAULT_GLOBAL_PERMISSION_CAPABILITIES.length)
    expect(grants).toEqual(
      expect.arrayContaining(
        DEFAULT_GLOBAL_PERMISSION_CAPABILITIES.map((capability) =>
          expect.objectContaining({
            capability,
            scope: { kind: 'global' }
          })
        )
      )
    )
    await expect(
      fixture.client.permissionGrantSeed.findUnique({
        where: { id: 'global-customize-v1' },
        select: { id: true }
      })
    ).resolves.toEqual({ id: 'global-customize-v1' })
  })

  it('does not backfill new defaults after the v1 seed was applied', async () => {
    const fixture = await setup()
    await fixture.client.permissionGrantSeed.create({
      data: { id: 'global-customize-v1', appliedAt: new Date() }
    })

    await seedDefaultPermissionGrants(fixture.registry, fixture.client)

    await expect(fixture.registry.list()).resolves.toEqual([])
  })

  it('does not recreate a revoked default on a later startup', async () => {
    const fixture = await setup()
    await seedDefaultPermissionGrants(fixture.registry, fixture.client)
    const [revoked] = await fixture.registry.list()
    await fixture.registry.revoke({ grants: [{ id: revoked!.id, revision: revoked!.revision }] })

    const reopenedRegistry = await createPermissionGrantRegistry({
      getClient: async () => fixture.client
    })
    await seedDefaultPermissionGrants(reopenedRegistry, fixture.client)

    await expect(reopenedRegistry.list()).resolves.toHaveLength(
      DEFAULT_GLOBAL_PERMISSION_CAPABILITIES.length - 1
    )
  })
})
