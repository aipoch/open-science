import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { markContentBlobAvailable, registerContentBlob } from './content-blob-registry'

describe('content blob registry', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('registers immutable metadata idempotently and advances only verified bytes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-content-blob-registry-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    const input = {
      id: 'upload-version:version-1',
      storageKey: 'uploads/project/session/upload/versions/version-1/content',
      checksum: 'a'.repeat(64),
      sizeBytes: 42n,
      contentType: 'application/pdf'
    }

    await client.$transaction((transaction) => registerContentBlob(transaction, input))
    await client.$transaction((transaction) => registerContentBlob(transaction, input))
    await expect(client.contentBlob.findMany()).resolves.toEqual([
      expect.objectContaining({ ...input, state: 'staging', verifiedAt: null })
    ])

    await client.$transaction((transaction) => markContentBlobAvailable(transaction, input))
    await expect(
      client.contentBlob.findUniqueOrThrow({ where: { id: input.id } })
    ).resolves.toEqual(
      expect.objectContaining({ state: 'available', verifiedAt: expect.any(Date) })
    )
  })

  it('rejects reuse of either identity for different immutable bytes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-content-blob-conflict-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    const input = {
      id: 'artifact-version:version-1',
      storageKey: 'artifacts/project/session/version-1/content',
      checksum: 'b'.repeat(64),
      sizeBytes: 7n
    }
    await client.$transaction((transaction) => registerContentBlob(transaction, input))

    await expect(
      client.$transaction((transaction) =>
        registerContentBlob(transaction, { ...input, checksum: 'c'.repeat(64) })
      )
    ).rejects.toThrow(/conflicts with immutable bytes/i)
    await expect(
      client.$transaction((transaction) =>
        registerContentBlob(transaction, {
          ...input,
          id: 'artifact-version:version-2'
        })
      )
    ).rejects.toThrow(/conflicts with immutable bytes/i)

    await client.contentBlob.update({
      where: { id: input.id },
      data: { state: 'quarantined' }
    })
    await expect(
      client.$transaction((transaction) => registerContentBlob(transaction, input))
    ).rejects.toThrow(/cannot acquire a new owner/i)
  })
})
