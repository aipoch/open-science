import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { SessionPackageService } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

it('handles cancellation during export validation before reaching later sensitive content', async () => {
  const fixture = await createProvenanceTestFixture()
  initDataRoot(fixture.storageRoot)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  let cancellation: NodeJS.Immediate | undefined
  try {
    await fixture.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    const sessions = new SessionRepository(fixture.storageRoot)
    await sessions.saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Research',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: Array.from({ length: 32 }, (_, index) => ({
        id: `message-${index}`,
        role: 'user',
        content:
          index === 31
            ? 'Authorization: Bearer synthetic-private-value'
            : 'Research evidence. '.repeat(512),
        status: 'complete',
        eventIds: [],
        createdAt: index,
        updatedAt: index
      }))
    })
    const request = { projectId: 'project-1', sessionId: 'session-1' }
    const before = await sessions.loadSession(request.projectId, request.sessionId)
    const destination = join(fixture.storageRoot, 'research.science')
    await writeFile(destination, 'previous export')
    const controller = new AbortController()
    const reason = new Error('Cancel requested during validation')
    await expect(
      service.exportTo(request, destination, {
        signal: controller.signal,
        selectFiles: async () => {
          // The next event-loop turn represents a Cancel event arriving from the UI.
          // A synchronous scan reaches the final credential before this can run.
          cancellation = setImmediate(() => controller.abort(reason))
          return []
        }
      })
    ).rejects.toBe(reason)
    expect(await readFile(destination, 'utf8')).toBe('previous export')
    expect(await sessions.loadSession(request.projectId, request.sessionId)).toEqual(before)

    // Cancellation must release the operation owner; a retry still checks the entire history.
    await expect(service.exportTo(request, destination)).rejects.toThrow(
      'Sensitive content detected'
    )
    expect(await readFile(destination, 'utf8')).toBe('previous export')
  } finally {
    if (cancellation) clearImmediate(cancellation)
    await service.close()
    await fixture.dispose()
    initDataRoot(undefined)
  }
})
