import { constants } from 'node:fs'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aroundAll, expect } from 'vitest'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'

// Each case owns its client and writable database, including any WAL created after opening it.
export function registerDatabaseFixture(): (
  root: string
) => Promise<ReturnType<typeof createProjectDbClient>> {
  let seed: string
  aroundAll(async (runSuite) => {
    seed = await mkdtemp(join(tmpdir(), 'open-science-migrated-seed-'))
    try {
      const client = createProjectDbClient(seed)
      try {
        await migrateApplicationDatabase(client)
      } finally {
        await client.$disconnect()
      }
      expect(await readdir(seed)).toEqual(['open-science.db'])
      await runSuite()
    } finally {
      await rm(seed, { recursive: true, force: true })
    }
  })
  return async (root) => {
    await copyFile(
      join(seed, 'open-science.db'),
      join(root, 'open-science.db'),
      constants.COPYFILE_EXCL
    )
    return createProjectDbClient(root)
  }
}
