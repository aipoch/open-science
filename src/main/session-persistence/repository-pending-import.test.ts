import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { SessionRepository } from './repository'
import { initDataRoot } from '../storage-root'
import { SessionJournalStore } from './journal'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (): Promise<{
  root: string
  pending: string
  session: PersistedChatSession
}> => {
  const root = await mkdtemp(join(tmpdir(), 'session-journal-pending-import-'))
  roots.push(root)
  initDataRoot(root)
  const importId = '12345678-1234-1234-1234-123456789abc'
  const projectId = `import-${importId}`
  const repository = new SessionRepository(root)
  await repository.saveSession({
    id: 'import-session',
    projectId,
    number: 7,
    title: 'Imported evidence',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      {
        id: 'm',
        role: 'user',
        content: 'Original research',
        status: 'complete',
        createdAt: 1,
        updatedAt: 1,
        eventIds: []
      }
    ],
    packageOrigin: {
      importId,
      sourceProjectId: 'source',
      sourceSessionId: 'source-session',
      importedAt: 1,
      manifestChecksum: 'a'.repeat(64)
    }
  })
  const session = await repository.loadSession(projectId, 'import-session')
  if (!session) throw new Error('Expected published fixture before restoring its import fence')
  const pending = join(root, 'session-package-imports', importId)
  await mkdir(pending, { recursive: true })
  return { root, pending, session }
}

it('resumes a hidden imported publication using durable CAS and keeps its assigned number', async () => {
  const { root, pending, session } = await fixture()
  const repository = new SessionRepository(root)
  await expect(repository.loadSession(session.projectId, session.id)).resolves.toBeUndefined()
  await expect(
    repository.loadSessionWithDiagnostics(session.projectId, session.id)
  ).resolves.toEqual({ status: 'missing' })
  const saved = await repository.saveSession(
    { ...session, number: undefined, title: 'Recovered publication' },
    1
  )
  expect(saved).toMatchObject({ revision: 2, number: 7, title: 'Recovered publication' })
  await expect(repository.saveSession(saved, 1)).rejects.toMatchObject({
    expectedRevision: 1,
    actualRevision: 2
  })
  await expect(repository.loadSession(session.projectId, session.id)).resolves.toBeUndefined()
  await rm(pending, { recursive: true })
  await expect(
    new SessionRepository(root).loadSession(session.projectId, session.id)
  ).resolves.toMatchObject({
    revision: 2,
    number: 7,
    title: 'Recovered publication',
    messages: session.messages
  })
})

it('still rejects research-content edits while an imported publication is hidden', async () => {
  const { root, session } = await fixture()
  const path = join(root, 'sessions', session.projectId, `${session.id}.json`)
  const files = (await new SessionJournalStore({ maxBytes: 1024 * 1024 }).inspectStorage(path))
    .paths
  const before = await Promise.all(files.map((file) => readFile(file, 'utf8')))
  await expect(
    new SessionRepository(root).saveSession(
      {
        ...session,
        number: undefined,
        messages: session.messages.map((message) => ({ ...message, content: 'Replaced research' }))
      },
      1
    )
  ).rejects.toThrow('read-only')
  expect(await Promise.all(files.map((file) => readFile(file, 'utf8')))).toEqual(before)
})

it('keeps ordinary published import metadata validation unchanged', async () => {
  const { root, pending, session } = await fixture()
  await rm(pending, { recursive: true })
  await expect(
    new SessionRepository(root).saveSession({ ...session, number: 999 }, session.revision)
  ).rejects.toThrow('read-only')
  await expect(
    new SessionRepository(root).loadSession(session.projectId, session.id)
  ).resolves.toMatchObject({ number: 7, revision: 1 })
})
