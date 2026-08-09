import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS, seedDefaultPermissionGrants } from './defaults'
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
  await ensureProjectSchema(client)
  const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
  return { client, registry }
}

describe('default permission grants', () => {
  it('seeds the registered customization permissions globally', async () => {
    const fixture = await setup()

    await seedDefaultPermissionGrants(fixture.registry, fixture.client)

    expect(DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS).toEqual(
      PRE_REGISTERED_PERMISSION_IDENTITIES.customize_mutation
    )
    const grants = await fixture.registry.list()
    expect(grants.map((grant) => grant.capability.key)).toEqual(
      [...DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS].sort()
    )
    expect(grants).toEqual(
      expect.arrayContaining(
        DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS.map((key) =>
          expect.objectContaining({
            capability: { kind: 'customize_mutation', key },
            scope: { kind: 'global' }
          })
        )
      )
    )
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
      DEFAULT_GLOBAL_CUSTOMIZE_PERMISSION_KEYS.length - 1
    )
  })
})
