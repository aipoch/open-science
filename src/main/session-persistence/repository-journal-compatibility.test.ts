import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createSessionFile,
  decodeSessionFile,
  SessionRevisionConflictError,
  type PersistedChatSession
} from '../../shared/session-persistence'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { SessionRepository } from './repository'
import { SessionJournalStore, sessionJournalPath, sessionLegacyBackupPath } from './journal'
import { initDataRoot } from '../storage-root'
import { defaultFileDurability } from '@aipoch/durable-files'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (): Promise<{
  root: string
  path: string
  session: PersistedChatSession
}> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-journal-compat-'))
  roots.push(root)
  initDataRoot(root)
  const directory = join(root, 'sessions', 'p')
  await mkdir(directory, { recursive: true })
  return {
    root,
    path: join(directory, 's.json'),
    session: {
      id: 's',
      projectId: 'p',
      title: 'Historical research',
      cwd: '/work',
      revision: 12,
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'u',
          role: 'user',
          content: 'Preserve my research',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
  }
}

const seedJournal = async (
  path: string,
  session: PersistedChatSession,
  retainLegacyBackup = false
): Promise<void> => {
  const document = createSessionFile(session)
  await writeFile(
    sessionJournalPath(path),
    JSON.stringify({ type: 'session_snapshot', document }) + '\n'
  )
  // A retained migration backup models existing data, not a new save side effect.
  if (retainLegacyBackup) await writeFile(sessionLegacyBackupPath(path), JSON.stringify(document))
}

it('reports an authority advance between validation and preparation as a revision conflict', async () => {
  const { root, path, session } = await fixture()
  const original = { ...session, revision: 1 }
  const external = { ...session, revision: 2, title: 'External committed research' }
  const store = new SessionJournalStore({ maxBytes: 1024 * 1024 })
  await store.write(path, {
    document: createSessionFile(original),
    expectedRevision: 0
  })
  const read = SessionJournalStore.prototype.read
  let advanceAfterRead = true
  vi.spyOn(SessionJournalStore.prototype, 'read').mockImplementation(async function (
    this: SessionJournalStore,
    path
  ) {
    const result = await read.call(this, path)
    if (advanceAfterRead) {
      advanceAfterRead = false
      await store.write(path, {
        document: createSessionFile(external),
        expectedRevision: 1
      })
    }
    return result
  })
  const repository = new SessionRepository(root)
  const failed = repository.saveSession({ ...original, title: 'Stale local update' }, 1)
  await expect(failed).rejects.toBeInstanceOf(SessionRevisionConflictError)
  await expect(failed).rejects.toMatchObject({ expectedRevision: 1, actualRevision: 2 })
  expect(await new SessionRepository(root).loadSessionWithDiagnostics('p', 's')).toMatchObject({
    status: 'found',
    session: { revision: 2, title: external.title, messages: original.messages }
  })
})

it('keeps historical JSON through consecutive saves and restores the latest state cold', async () => {
  const { root, path, session } = await fixture()
  const oldBytes = JSON.stringify(createSessionFile(session), null, 2) + '\n'
  await writeFile(path, oldBytes)
  const journalReads = vi.spyOn(SessionJournalStore.prototype, 'read')
  const journalPreparations = vi.spyOn(SessionJournalStore.prototype, 'prepareWrite')
  const journalWrites = vi.spyOn(SessionJournalStore.prototype, 'write')
  const preparedJournalWrites = vi.spyOn(SessionJournalStore.prototype, 'writePrepared')
  const repository = new SessionRepository(root)
  const opened = await repository.loadSessionWithDiagnostics('p', 's', { mode: 'read-only' })
  expect(opened.status).toBe('found')
  expect(await readFile(path, 'utf8')).toBe(oldBytes)
  expect(await readdir(join(root, 'sessions', 'p'))).toEqual(['s.json'])
  if (opened.status !== 'found') throw new Error('Historical fixture was not readable')
  const continued = await repository.saveSession(
    { ...opened.session, title: 'Continued research' },
    12
  )
  expect(continued.revision).toBe(13)
  expect(decodeSessionFile(JSON.parse(await readFile(path, 'utf8')))).toMatchObject({
    status: 'ok',
    session: { revision: 13, title: 'Continued research' }
  })
  await repository.saveSession({ ...continued, title: 'Latest research' }, 13)
  expect(await readdir(join(root, 'sessions', 'p'))).toEqual(['s.json'])
  const restored = await new SessionRepository(root).loadSessionWithDiagnostics('p', 's')
  expect(restored).toMatchObject({
    status: 'found',
    session: {
      title: 'Latest research',
      revision: 14,
      messages: [{ id: 'u', content: 'Preserve my research' }]
    }
  })
  const savedBytes = await readFile(path, 'utf8')
  await expect(
    repository.saveSession({ ...continued, title: 'Stale overwrite' }, 13)
  ).rejects.toMatchObject({
    name: 'SessionRevisionConflictError',
    expectedRevision: 13,
    actualRevision: 14
  })
  expect(await readFile(path, 'utf8')).toBe(savedBytes)
  // Keeping the old format must also keep the original snapshot path; routing these saves
  // through the journal would parse, freeze and measure the complete history again.
  expect(journalReads).not.toHaveBeenCalled()
  expect(journalPreparations).not.toHaveBeenCalled()
  expect(journalWrites).not.toHaveBeenCalled()
  expect(preparedJournalWrites).not.toHaveBeenCalled()
  // The complete self-contained JSON remains the writable authority.
  const durable = await new SessionJournalStore({ maxBytes: 1024 * 1024 }).read(path)
  expect(durable!.format).toBe('legacy')
  expect(decodeSessionFile(durable!.document)).toMatchObject({
    status: 'ok',
    session: { revision: 14 }
  })
})

it('preserves historical authority if atomic JSON replacement fails, then retries safely', async () => {
  const { root, path, session } = await fixture()
  const oldBytes = JSON.stringify(createSessionFile(session))
  await writeFile(path, oldBytes)
  const repository = new SessionRepository(root, {
    renameFile: async (source, destination) => {
      if (destination === path) throw new Error('injected JSON replacement failure')
      await rename(source, destination)
    }
  })
  await expect(repository.saveSession({ ...session, title: 'New title' }, 12)).rejects.toThrow(
    'injected JSON replacement'
  )
  expect(await readFile(path, 'utf8')).toBe(oldBytes)
  expect(await new SessionRepository(root).loadSessionWithDiagnostics('p', 's')).toMatchObject({
    status: 'found',
    session: { revision: 12, title: session.title }
  })
  await expect(readFile(sessionJournalPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(sessionLegacyBackupPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
  await new SessionRepository(root).saveSession({ ...session, title: 'Retried title' }, 12)
  expect(await new SessionRepository(root).loadSessionWithDiagnostics('p', 's')).toMatchObject({
    status: 'found',
    session: { revision: 13, title: 'Retried title', messages: session.messages }
  })
})

it('recovers committed historical JSON after directory sync fails and rejects a stale retry', async () => {
  const { root, path, session } = await fixture()
  await writeFile(path, JSON.stringify(createSessionFile(session)))
  let published = false
  let failSync = true
  const repository = new SessionRepository(root, {
    renameFile: async (source, destination) => {
      await rename(source, destination)
      if (destination === path) published = true
    }
  })
  const sync = defaultFileDurability.syncDirectory
  vi.spyOn(defaultFileDurability, 'syncDirectory').mockImplementation(async (directory) => {
    if (published && failSync) {
      failSync = false
      throw new Error('injected JSON directory sync failure')
    }
    await sync(directory)
  })
  await expect(
    repository.saveSession({ ...session, title: 'Committed before sync failure' }, 12)
  ).rejects.toThrow('injected JSON directory sync failure')
  const committedBytes = await readFile(path, 'utf8')
  const restored = await new SessionRepository(root).loadSessionWithDiagnostics('p', 's')
  expect(restored).toMatchObject({
    status: 'found',
    session: {
      revision: 13,
      title: 'Committed before sync failure',
      messages: session.messages
    }
  })
  await expect(
    repository.saveSession({ ...session, title: 'Stale retry' }, 12)
  ).rejects.toMatchObject({
    name: 'SessionRevisionConflictError',
    expectedRevision: 12,
    actualRevision: 13
  })
  expect(await readFile(path, 'utf8')).toBe(committedBytes)
  if (restored.status !== 'found') throw new Error('Committed historical JSON was not readable')
  await repository.saveSession({ ...restored.session, title: 'Continued after recovery' }, 13)
  expect(await new SessionRepository(root).loadSessionWithDiagnostics('p', 's')).toMatchObject({
    status: 'found',
    session: { revision: 14, title: 'Continued after recovery', messages: session.messages }
  })
  expect(await readdir(join(root, 'sessions', 'p'))).toEqual(['s.json'])
})

it('reads an external JSON replacement after rename from both the same and a fresh repository', async () => {
  const { root, path, session } = await fixture()
  await writeFile(path, JSON.stringify(createSessionFile(session)))
  const external = { ...session, revision: 14, title: 'External writer committed after rename' }
  const externalBytes = JSON.stringify(createSessionFile(external), null, 2) + '\n'
  const repository = new SessionRepository(root, {
    renameFile: async (source, destination) => {
      await rename(source, destination)
      if (destination === path) await writeFile(destination, externalBytes)
    }
  })
  const local = await repository.saveSession({ ...session, title: 'Local candidate' }, 12)
  expect(local.revision).toBe(13)
  for (const reader of [repository, new SessionRepository(root)]) {
    expect(await reader.loadSessionWithDiagnostics('p', 's')).toMatchObject({
      status: 'found',
      session: { revision: 14, title: external.title, messages: session.messages }
    })
    await expect(
      reader.saveSession({ ...local, title: 'Stale overwrite' }, 13)
    ).rejects.toMatchObject({
      name: 'SessionRevisionConflictError',
      expectedRevision: 13,
      actualRevision: 14
    })
  }
  expect(await readFile(path, 'utf8')).toBe(externalBytes)
  expect(await readdir(join(root, 'sessions', 'p'))).toEqual(['s.json'])
})

it.each(['legacy', 'journal'] as const)(
  'preserves %s authority while updating a committed Project Session',
  async (format) => {
    const { root, path, session } = await fixture()
    if (format === 'legacy') await writeFile(path, JSON.stringify(createSessionFile(session)))
    else await seedJournal(path, session)
    const repository = new SessionRepository(root)
    await repository.deleteProjectSessions('p')
    const tombstone = join(root, 'deleted-sessions', 'p')
    // Older releases left an unmarked committed directory. Recreate that historical state
    // after the real deletion rename, then exercise its supported repair/marking APIs.
    await rm(join(tombstone, '.project-deletion-committed'))
    expect(await repository.getProjectSessionDeletionState('p')).toBe('legacy-committed')
    await repository.saveCommittedProjectSession({
      ...session,
      title: 'Recovered deletion history'
    })
    const cold = new SessionRepository(root)
    const restored = await cold.loadCommittedProjectWithDiagnostics('p')
    expect(restored).toMatchObject({
      isComplete: true,
      sessions: [{ revision: 13, title: 'Recovered deletion history', messages: session.messages }]
    })
    expect(restored.sessions).toHaveLength(1)
    await cold.saveCommittedProjectSession({
      ...restored.sessions[0],
      title: 'Latest deletion history'
    })
    expect(
      await new SessionRepository(root).loadCommittedProjectWithDiagnostics('p')
    ).toMatchObject({
      isComplete: true,
      sessions: [{ revision: 14, title: 'Latest deletion history', messages: session.messages }]
    })
    expect(await readdir(tombstone)).toEqual([format === 'legacy' ? 's.json' : 's.jsonl'])
    expect(await new SessionRepository(root).loadSession('p', 's')).toBeUndefined()
    await cold.markCommittedProjectSessionsPrepared('p')
    expect(await new SessionRepository(root).getProjectSessionDeletionState('p')).toBe('prepared')
  }
)

it('ignores only an incomplete trailing record and never mutates it during historical reads', async () => {
  const { root, path, session } = await fixture()
  await seedJournal(path, session)
  const repository = new SessionRepository(root)
  const saved = await repository.saveSession({ ...session, title: 'Committed' }, 12)
  const log = sessionJournalPath(path)
  await appendFile(log, '{"version":1,"incomplete":')
  const torn = await readFile(log, 'utf8')
  expect(
    await new SessionRepository(root).loadSessionWithDiagnostics('p', 's', { mode: 'read-only' })
  ).toMatchObject({
    status: 'found',
    session: { title: 'Committed', revision: 13 }
  })
  expect(await readFile(log, 'utf8')).toBe(torn)
  await repository.saveSession({ ...saved, title: 'After restart' }, 13)
  expect(await new SessionRepository(root).loadSessionWithDiagnostics('p', 's')).toMatchObject({
    status: 'found',
    session: { title: 'After restart', revision: 14 }
  })
})

it('keeps a corrupt complete journal record in place and blocks overwriting its history', async () => {
  const { root, path, session } = await fixture()
  await seedJournal(path, session)
  const repository = new SessionRepository(root)
  const saved = await repository.saveSession(session, 12)
  const log = sessionJournalPath(path)
  await appendFile(log, '{broken-complete-record}\n')
  const before = await readFile(log, 'utf8')
  expect(await repository.loadSessionWithDiagnostics('p', 's')).toEqual({ status: 'unreadable' })
  expect(await readFile(log, 'utf8')).toBe(before)
  await expect(
    repository.saveSession({ ...saved, title: 'Overwrite attempt' }, 13)
  ).rejects.toThrow('unreadable')
  expect(await readFile(log, 'utf8')).toBe(before)
})

it('deletes existing JSONL and retained migration backup without deleting similarly named sessions', async () => {
  const { root, path, session } = await fixture()
  await seedJournal(path, session, true)
  const repository = new SessionRepository(root)
  await repository.saveSession(session, 12)
  const unrelated = join(root, 'sessions', 'p', 's-extra.json')
  await writeFile(unrelated, 'unrelated')
  await repository.deleteSession('p', 's')
  expect(await readdir(join(root, 'sessions', 'p'))).toEqual(['s-extra.json'])
  expect(await readFile(unrelated, 'utf8')).toBe('unrelated')
})

it('treats a missing JSONL with a retained legacy backup as unreadable authority', async () => {
  const { root, path, session } = await fixture()
  await seedJournal(path, session, true)
  const repository = new SessionRepository(root)
  await repository.saveSession(session, 12)
  await rm(sessionJournalPath(path))
  const before = await readdir(join(root, 'sessions', 'p'))
  const restarted = new SessionRepository(root)
  expect(await restarted.loadSessionWithDiagnostics('p', 's')).toEqual({ status: 'unreadable' })
  expect((await restarted.loadAllWithDiagnostics()).isComplete).toBe(false)
  await expect(restarted.saveSession({ ...session, messages: [] })).rejects.toThrow('unreadable')
  expect(await readdir(join(root, 'sessions', 'p'))).toEqual(before)
})

it.each([
  ['single', 'backup'],
  ['single', 'jsonl-temp'],
  ['directory', 'backup'],
  ['directory', 'jsonl-temp']
] as const)(
  'does not promote a legacy temp during %s recovery beside orphan %s evidence',
  async (mode, evidence) => {
    const { root, path, session } = await fixture()
    const legacy = JSON.stringify(createSessionFile(session))
    const temporary = `${path}.1700000000000-1.tmp`
    const retained =
      evidence === 'backup'
        ? sessionLegacyBackupPath(path)
        : `${sessionJournalPath(path)}.pending.tmp`
    await writeFile(temporary, legacy)
    await writeFile(retained, evidence === 'backup' ? legacy : '{incomplete-new-authority')
    const before = await readdir(join(root, 'sessions', 'p'))
    const repository = new SessionRepository(root)
    if (mode === 'single') {
      expect(await repository.loadSessionWithDiagnostics('p', 's')).toEqual({
        status: 'unreadable'
      })
    } else {
      const read = await repository.loadAllWithDiagnostics()
      expect(read.isComplete).toBe(false)
      expect(read.result.sessions).toEqual([])
    }
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(temporary, 'utf8')).toBe(legacy)
    expect(await readdir(join(root, 'sessions', 'p'))).toEqual(before)
    await expect(repository.saveSession(session)).rejects.toThrow('unreadable')
    expect(await readdir(join(root, 'sessions', 'p'))).toEqual(before)
  }
)

it.each(['single', 'directory'] as const)(
  'still promotes a legacy temp during %s recovery without JSONL evidence',
  async (mode) => {
    const { root, path, session } = await fixture()
    const legacy = JSON.stringify(createSessionFile(session))
    const temporary = `${path}.1700000000000-1.tmp`
    await writeFile(temporary, legacy)
    const repository = new SessionRepository(root)
    if (mode === 'single') {
      expect(await repository.loadSessionWithDiagnostics('p', 's')).toMatchObject({
        status: 'found',
        session: { revision: 12 }
      })
    } else {
      const read = await repository.loadAllWithDiagnostics()
      expect(read.isComplete).toBe(true)
      expect(read.result.sessions).toMatchObject([{ id: 's', revision: 12 }])
    }
    expect(await readFile(path, 'utf8')).toBe(legacy)
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

it('keeps complete authority and can retry when backup cleanup fails before primary deletion', async () => {
  const { root, path, session } = await fixture()
  await seedJournal(path, session, true)
  await new SessionRepository(root).saveSession(session, 12)
  const primary = await readFile(sessionJournalPath(path), 'utf8')
  let fail = true
  const repository = new SessionRepository(root, {
    remove: async (target, options) => {
      if (fail && target === sessionLegacyBackupPath(path)) {
        fail = false
        throw new Error('injected backup cleanup failure')
      }
      await rm(target, options)
    }
  })
  await expect(repository.deleteSession('p', 's')).rejects.toThrow('backup cleanup failure')
  expect(await readFile(sessionJournalPath(path), 'utf8')).toBe(primary)
  expect(await repository.loadSessionWithDiagnostics('p', 's')).toMatchObject({
    status: 'found',
    session: { revision: 13 }
  })
  await new SessionRepository(root).deleteSession('p', 's')
  expect(await readdir(join(root, 'sessions', 'p'))).toEqual([])
})

it('can continue a live Session after a failed final unlink without an extra deletion receipt', async () => {
  const { root, path, session } = await fixture()
  const repository = new SessionRepository(root, {
    remove: async (target, options) => {
      if (target === sessionJournalPath(path)) throw new Error('injected primary deletion failure')
      await rm(target, options)
    }
  })
  const saved = await repository.saveSession(session)
  await expect(repository.deleteSession('p', 's')).rejects.toThrow('primary deletion failure')
  await expect(repository.saveSession(saved, 0)).rejects.toMatchObject({
    name: 'SessionRevisionConflictError'
  })
  await repository.saveSession(
    { ...saved, title: 'New work after failed deletion' },
    saved.revision
  )
  expect(await new SessionRepository(root).loadSessionWithDiagnostics('p', 's')).toMatchObject({
    status: 'found',
    session: { title: 'New work after failed deletion' }
  })
  expect(await readdir(join(root, 'sessions', 'p'))).toEqual(['s.jsonl'])
})

it('reports deletion committed after final unlink even if its directory sync fails and safely retries', async () => {
  const { root, path, session } = await fixture()
  await seedJournal(path, session, true)
  await new SessionRepository(root).saveSession(session, 12)
  let primaryRemoved = false
  const removed: string[] = []
  const repository = new SessionRepository(root, {
    remove: async (target, options) => {
      await rm(target, options)
      removed.push(target)
      if (target === sessionJournalPath(path)) primaryRemoved = true
    }
  })
  const sync = defaultFileDurability.syncDirectory
  let fail = true
  vi.spyOn(defaultFileDurability, 'syncDirectory').mockImplementation(async (directory) => {
    if (primaryRemoved && fail) {
      fail = false
      throw new Error('injected final directory sync failure')
    }
    await sync(directory)
  })
  await expect(repository.deleteSession('p', 's')).rejects.toMatchObject({
    name: 'SessionDeletionCommittedError'
  })
  expect(removed.indexOf(sessionLegacyBackupPath(path))).toBeLessThan(
    removed.indexOf(sessionJournalPath(path))
  )
  expect(await repository.loadSessionWithDiagnostics('p', 's')).toEqual({ status: 'missing' })
  await repository.deleteSession('p', 's')
  expect(await readdir(join(root, 'sessions', 'p'))).toEqual([])
})

it('rejects a linked legacy backup before deleting authority or external data', async () => {
  const { root, path, session } = await fixture()
  const repository = new SessionRepository(root)
  await repository.saveSession(session)
  const before = await readFile(sessionJournalPath(path), 'utf8')
  const outside = join(root, 'external')
  await writeFile(outside, 'external evidence')
  await symlink(outside, sessionLegacyBackupPath(path))
  await expect(repository.deleteSession('p', 's')).rejects.toThrow('regular file')
  expect(await readFile(sessionJournalPath(path), 'utf8')).toBe(before)
  expect(await readFile(outside, 'utf8')).toBe('external evidence')
})
