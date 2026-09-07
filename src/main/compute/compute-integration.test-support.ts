import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { ComputeJobRepository } from './job-repository'

type MigratedComputeTestDatabase = Readonly<{
  storageRoot: string
  client: PrismaClient
  repositories: Readonly<{
    jobs: ComputeJobRepository
    operations: ComputeJobOperationRepository
  }>
  dispose(): Promise<void>
}>

export const createMigratedComputeTestDatabase = async (
  temporaryDirectoryPrefix: string
): Promise<MigratedComputeTestDatabase> => {
  const storageRoot = await mkdtemp(join(tmpdir(), temporaryDirectoryPrefix))
  const client = createProjectDbClient(storageRoot)
  try {
    await migrateApplicationDatabase(client)
  } catch (error) {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    throw error
  }

  let disposed = false
  return {
    storageRoot,
    client,
    repositories: {
      jobs: new ComputeJobRepository(() => Promise.resolve(client)),
      operations: new ComputeJobOperationRepository(() => Promise.resolve(client))
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      try {
        await client.$disconnect()
      } finally {
        await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }
  }
}
