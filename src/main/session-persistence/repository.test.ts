import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Session encode/decode falls back to resolveDataRoot(), which reads electron's app.getPath.
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { PersistedChatSession } from '../../shared/session-persistence'
import { DEV_SESSION_DIR_NAME, SessionRepository, getSessionPersistenceDir } from './repository'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-sessions-'))
  return storageRoot
}

const createSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Saved conversation',
  cwd: '/workspace/project',
  status: 'idle',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'Summarize this file',
      status: 'complete',
      eventIds: [],
      createdAt: 1710000000000,
      updatedAt: 1710000000000
    }
  ],
  createdAt: 1710000000000,
  updatedAt: 1710000000100,
  ...overrides
})

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('session persistence repository (per-session files)', () => {
  it('saves each session to sessions/<projectId>/<id>.json and loads it back', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const session = createSession()

    await repository.saveSession(session)

    const filePath = join(storageRoot!, 'sessions', 'project-a', 'session-1.json')
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { version: number }
    expect(raw.version).toBe(1)

    const { sessions } = await repository.loadAll()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Saved conversation',
      messages: [{ content: 'Summarize this file' }]
    })
  })

  it('sanitizes embedded message images before writing session JSON', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const session = createSession({
      messages: [
        {
          ...createSession().messages[0],
          role: 'agent',
          content: '',
          images: [
            { id: 'image-1', mimeType: 'image/png', data: 'AQID', byteLength: 999 },
            {
              id: 'image-svg',
              mimeType: 'image/svg+xml',
              data: 'PHN2Zz4=',
              byteLength: 5
            }
          ] as PersistedChatSession['messages'][number]['images']
        }
      ]
    })

    await repository.saveSession(session)

    const filePath = join(storageRoot!, 'sessions', 'project-a', 'session-1.json')
    const raw = await readFile(filePath, 'utf8')

    expect(raw).toContain('AQID')
    expect(raw).not.toContain('PHN2Zz4=')

    const { sessions } = await repository.loadAll()
    expect(sessions[0].messages[0].images).toEqual([
      { id: 'image-1', mimeType: 'image/png', data: 'AQID', byteLength: 3 }
    ])
  })

  it('returns an empty result when nothing is stored yet', async () => {
    const repository = new SessionRepository(await createStorageRoot())

    await expect(repository.loadAll()).resolves.toEqual({
      sessions: [],
      manifest: { version: 1 }
    })
  })

  it('sanitizes untrusted session-file content on load', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'session-1.json'),
      JSON.stringify({
        version: 1,
        session: {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Saved conversation',
          cwd: '/workspace/project',
          status: 'idle',
          extra: 'drop me',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Persisted prompt',
              status: 'complete',
              eventIds: ['event-1', 123],
              createdAt: 1,
              updatedAt: 1,
              extra: 'drop me'
            }
          ],
          artifacts: [
            {
              id: 'artifact-1',
              kind: 'workspace-file',
              path: '/workspace/project/report.md',
              content: 'do not persist file contents'
            }
          ],
          createdAt: 1,
          updatedAt: 2
        }
      }),
      'utf8'
    )

    const { sessions } = await repository.loadAll()

    expect(sessions[0]).not.toHaveProperty('extra')
    expect(sessions[0].messages[0]).toMatchObject({ eventIds: ['event-1'] })
    expect(sessions[0].messages[0]).not.toHaveProperty('extra')
    expect(sessions[0].artifacts?.[0]).toEqual({
      id: 'artifact-1',
      kind: 'workspace-file',
      path: '/workspace/project/report.md',
      // Decode always recomputes fileUrl from the (possibly-relocated) resolved path; pathToFileURL
      // drive-prefixes on Windows, so derive the expected the same way rather than hardcoding it.
      fileUrl: pathToFileURL('/workspace/project/report.md').href
    })
  })

  it('backs up an unreadable session file and skips it', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'broken.json'), '{broken json', 'utf8')

    const { sessions } = await repository.loadAll()
    expect(sessions).toEqual([])

    const remaining = await readdir(projectDir)
    expect(remaining).toContainEqual(expect.stringMatching(/^broken\.json\.invalid-/))
  })

  it('normalizes interrupted runs and open activities on load', async () => {
    const repository = new SessionRepository(await createStorageRoot())

    // saveSession writes verbatim, so this simulates an app that closed mid-run.
    await repository.saveSession(
      createSession({
        status: 'waiting-permission',
        activeRun: { promptMessageId: 'message-1', startedAt: 1710000000200 },
        messages: [
          {
            id: 'message-2',
            role: 'agent',
            content: 'Partial',
            status: 'streaming',
            streamId: 'assistant-message-1',
            eventIds: ['event-1'],
            createdAt: 1,
            updatedAt: 1
          }
        ],
        activities: [
          {
            id: 'activity-open',
            kind: 'tool',
            title: 'downloading',
            status: 'in_progress',
            sortIndex: 1,
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )

    const { sessions } = await repository.loadAll()

    expect(sessions[0]).toMatchObject({
      status: 'error',
      error: 'Session was interrupted before the app closed.'
    })
    expect(sessions[0].activeRun).toBeUndefined()
    expect(sessions[0].messages[0].status).toBe('error')
    expect(sessions[0].activities?.[0].status).toBe('failed')
  })

  it('deletes a single session file and a whole project directory', async () => {
    const repository = new SessionRepository(await createStorageRoot())

    await repository.saveSession(createSession({ id: 'session-1', projectId: 'project-a' }))
    await repository.saveSession(createSession({ id: 'session-2', projectId: 'project-a' }))
    await repository.saveSession(createSession({ id: 'session-3', projectId: 'project-b' }))

    await repository.deleteSession('project-a', 'session-1')
    expect((await repository.loadAll()).sessions.map((session) => session.id).sort()).toEqual([
      'session-2',
      'session-3'
    ])

    await repository.deleteProjectSessions('project-a')
    expect((await repository.loadAll()).sessions.map((session) => session.id)).toEqual([
      'session-3'
    ])
  })

  it('round-trips the manifest', async () => {
    const repository = new SessionRepository(await createStorageRoot())

    await repository.saveManifest({ lastProjectId: 'project-a', lastSessionId: 'session-1' })

    await expect(repository.loadAll()).resolves.toMatchObject({
      manifest: { version: 1, lastProjectId: 'project-a', lastSessionId: 'session-1' }
    })
  })

  it('ignores a legacy single-file sessions.json (migration was removed)', async () => {
    const root = await createStorageRoot()
    const repository = new SessionRepository(root)
    await mkdir(root, { recursive: true })

    await writeFile(
      join(root, 'sessions.json'),
      JSON.stringify({
        version: 1,
        selectedSessionId: 'legacy-1',
        sessions: [{ id: 'legacy-1', title: 'Legacy', cwd: '/x', status: 'idle', messages: [] }]
      }),
      'utf8'
    )

    // The legacy file is neither imported nor deleted — it is simply left untouched on disk.
    const { sessions } = await repository.loadAll()
    expect(sessions).toEqual([])
    const rootEntries = await readdir(root)
    expect(rootEntries).toContain('sessions.json')
  })

  it('treats the session file directory as the authoritative project id', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    // File content claims a different project than its directory; the directory wins on load.
    await writeFile(
      join(projectDir, 'session-1.json'),
      JSON.stringify({
        version: 1,
        session: createSession({ id: 'session-1', projectId: 'stale-project' })
      }),
      'utf8'
    )

    const { sessions } = await repository.loadAll()
    expect(sessions[0]).toMatchObject({ id: 'session-1', projectId: 'project-a' })
  })

  it('keeps session data in ~/.open-science under the user home directory by default', () => {
    // Build the expectation with join() so the separator matches the host the test runs on.
    expect(getSessionPersistenceDir('/Users/example')).toBe(join('/Users/example', '.open-science'))
  })

  it('uses the isolated dev directory name when requested', () => {
    expect(getSessionPersistenceDir('/Users/example', DEV_SESSION_DIR_NAME)).toBe(
      join('/Users/example', '.open-science-project')
    )
  })
})
