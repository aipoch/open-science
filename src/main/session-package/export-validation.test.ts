import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync } from 'fflate'
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

it.each([
  [
    'binary ZIP bytes under an extensionless evidence name',
    Buffer.from(zipSync({ 'token=measurements.csv': Buffer.from('year,flights\n2026,300\n') })),
    true
  ],
  [
    'binary content after a text-like prefix',
    Buffer.concat([
      Buffer.from('Authorization: Bearer synthetic-private-value\n'),
      Buffer.alloc(70 * 1024, 65),
      Buffer.from([0xff])
    ]),
    true
  ],
  [
    'NUL-bearing binary data',
    Buffer.from('binary\0Authorization: Bearer synthetic-private-value'),
    true
  ],
  [
    'incomplete UTF-8 at EOF',
    Buffer.concat([
      Buffer.from('Authorization: Bearer synthetic-private-value'),
      Buffer.from([0xe7])
    ]),
    true
  ],
  [
    'credentials crossing a chunk boundary',
    Buffer.from('a'.repeat(65530) + '\nAuthorization: Bearer synthetic-private-value'),
    false
  ],
  [
    'extensionless UTF-8 credentials',
    Buffer.from('Authorization: Bearer synthetic-private-value'),
    false
  ],
  [
    'text disguised with a ZIP extension',
    Buffer.from('Authorization: Bearer synthetic-private-value'),
    false
  ],
  [
    'UTF-8 text crossing a chunk boundary',
    Buffer.from('a'.repeat(65535) + '研究\nplain results'),
    true
  ]
])('classifies %s before applying text credential checks', async (label, bytes, allowed) => {
  const fixture = await createProvenanceTestFixture()
  initDataRoot(fixture.storageRoot)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  try {
    await fixture.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    await new SessionRepository(fixture.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Research',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    const directory = join(fixture.storageRoot, 'notebooks', 'project-1', 'session-1', 'data')
    await mkdir(directory, { recursive: true })
    const source = join(
      directory,
      label === 'text disguised with a ZIP extension' ? 'data.zip' : 'content'
    )
    await writeFile(source, bytes)
    const destination = join(fixture.storageRoot, 'result.science')
    const pending = service.exportTo(
      { projectId: 'project-1', sessionId: 'session-1' },
      destination
    )
    if (allowed) {
      await expect(pending).resolves.toBeDefined()
      const imported = await service.importFrom(destination)
      await expect(
        service.exportTo(imported, join(fixture.storageRoot, 'forwarded.science'))
      ).resolves.toBeDefined()
    } else await expect(pending).rejects.toThrow('Sensitive content detected')
    expect(await readFile(source)).toEqual(bytes)
  } finally {
    await service.close()
    await fixture.dispose()
    initDataRoot(undefined)
  }
})
