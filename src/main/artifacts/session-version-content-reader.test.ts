import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { readPublishedSessionVersionsByContent } from './session-version-content-reader'

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Receiving research',
  cwd: '',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}
const request = {
  projectId: session.projectId,
  appSessionId: session.id,
  contents: [{ checksum: 'a'.repeat(64), sizeBytes: 100 }]
}
describe('bounded receiving Session historical content lookup', () => {
  it('rejects invalid and oversized lookup sets before reading Session or database state', async () => {
    const dependencies = {
      getClient: vi.fn<() => Promise<PrismaClient>>(),
      loadSession: vi.fn(async () => session)
    }
    for (const contents of [
      Array.from({ length: 101 }, () => request.contents[0]),
      [{ checksum: 'invalid', sizeBytes: 1 }],
      [{ checksum: 'a'.repeat(64), sizeBytes: -1 }],
      [{ checksum: 'a'.repeat(64), sizeBytes: Number.MAX_SAFE_INTEGER + 1 }]
    ])
      await expect(
        readPublishedSessionVersionsByContent(dependencies, { ...request, contents })
      ).rejects.toThrow('Invalid bounded Session content lookup.')
    expect(dependencies.getClient).not.toHaveBeenCalled()
    expect(dependencies.loadSession).not.toHaveBeenCalled()
  })

  it('requires an existing receiving Session in the requested Project before querying', async () => {
    const getClient = vi.fn<() => Promise<PrismaClient>>()
    for (const loaded of [undefined, { ...session, projectId: 'other-project' }])
      await expect(
        readPublishedSessionVersionsByContent(
          {
            getClient,
            loadSession: async () => loaded
          },
          request
        )
      ).rejects.toThrow('Session ownership authority is unavailable.')
    expect(getClient).not.toHaveBeenCalled()
  })

  it('fails closed instead of truncating a large matching result into false uniqueness', async () => {
    const findMany = vi.fn(async () => Array.from({ length: 1001 }, () => ({})))
    const managedFindMany = vi.fn()
    const client = {
      projectDeletionIntent: { findUnique: async () => null },
      managedFileSessionSync: { findUnique: async () => null },
      artifactVersion: { findMany },
      managedFile: { findMany: managedFindMany }
    } as unknown as PrismaClient
    await expect(
      readPublishedSessionVersionsByContent(
        {
          getClient: async () => client,
          loadSession: async () => session
        },
        request
      )
    ).rejects.toThrow('Session content lookup exceeds its result limit.')
    expect(managedFindMany).not.toHaveBeenCalled()
  })
})
