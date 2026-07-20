import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { createManagedFileIndexRepository, ManagedFileIndexRepository } from './repository'

const PROJECT_ID = 'project-a'
const SESSION_ID = 'session-a'

const createSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: SESSION_ID,
  projectId: PROJECT_ID,
  title: 'Analysis',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_001_000,
  filesRevision: 1,
  ...overrides
})

describe('ManagedFileIndexRepository', () => {
  let storageRoot: string
  let client: PrismaClient
  let repository: ManagedFileIndexRepository

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-files-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    repository = new ManagedFileIndexRepository(() => Promise.resolve(client), storageRoot)
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('indexes uploads and all finalized managed artifacts without requiring a message link', async () => {
    const uploadPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const linkedArtifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-agent',
      'chart.png'
    )
    const orphanArtifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-orphan',
      'notes.txt'
    )

    await Promise.all([
      writeManagedFile(uploadPath, 'a,b\n1,2'),
      writeManagedFile(linkedArtifactPath, 'png'),
      writeManagedFile(orphanArtifactPath, 'notes')
    ])

    const changedSources = await repository.syncSession(
      createSession({
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-1',
                sessionId: SESSION_ID,
                name: 'input.csv',
                originalName: 'samples.csv',
                path: uploadPath,
                mimeType: 'text/csv',
                size: 7
              }
            ],
            createdAt: 1_710_000_000_100,
            updatedAt: 1_710_000_000_200
          },
          {
            id: 'message-agent',
            role: 'agent',
            content: 'Done',
            status: 'complete',
            eventIds: [],
            artifactIds: ['artifact-linked'],
            createdAt: 1_710_000_000_300,
            updatedAt: 1_710_000_000_400
          }
        ],
        artifacts: [
          {
            id: 'artifact-linked',
            kind: 'managed-file',
            path: linkedArtifactPath,
            name: 'chart.png',
            mimeType: 'image/png'
          },
          {
            id: 'artifact-orphan',
            kind: 'managed-file',
            path: orphanArtifactPath,
            name: 'notes.txt',
            mimeType: 'text/plain'
          }
        ]
      })
    )
    expect(changedSources).toEqual(['artifact', 'upload'])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toEqual({
      totalCount: 3,
      uploadCount: 1,
      artifactCount: 2,
      artifactGroupCount: 1,
      isIndexComplete: true
    })

    const uploads = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'uploads' },
      limit: 24
    })
    expect(uploads.items).toEqual([
      expect.objectContaining({
        source: 'upload',
        sourceFileId: 'upload-1',
        messageId: 'message-user',
        name: 'samples.csv',
        path: uploadPath
      })
    ])

    const artifacts = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(artifacts.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceFileId: 'artifact-linked', messageId: 'message-agent' }),
        expect.objectContaining({ sourceFileId: 'artifact-orphan', messageId: undefined })
      ])
    )

    await expect(
      repository.listArtifactGroups({ projectId: PROJECT_ID, limit: 10 })
    ).resolves.toEqual({
      items: [{ sessionId: SESSION_ID, artifactCount: 2 }],
      totalCount: 1,
      nextCursor: undefined
    })
  })

  it('keeps the SQLite config root separate from the relocatable data root', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'open-science-project-files-data-'))
    const getClientForRoot = vi.fn(async (root: string) => {
      expect(root).toBe(storageRoot)
      return client
    })
    const dataRepository = createManagedFileIndexRepository(getClientForRoot, storageRoot, dataRoot)
    const artifactPath = join(
      dataRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )

    try {
      await writeManagedFile(artifactPath, 'result')

      await expect(
        dataRepository.syncSession(
          createSession({
            artifacts: [
              {
                id: 'artifact-data-root',
                kind: 'managed-file',
                path: artifactPath,
                name: 'result.txt'
              }
            ]
          })
        )
      ).resolves.toEqual(['artifact'])
      await expect(dataRepository.getOverview(PROJECT_ID)).resolves.toMatchObject({
        totalCount: 1,
        artifactCount: 1,
        isIndexComplete: true
      })
      await expect(
        dataRepository.listFiles({
          projectId: PROJECT_ID,
          collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
          limit: 20
        })
      ).resolves.toMatchObject({ items: [expect.objectContaining({ path: artifactPath })] })
      expect(getClientForRoot).toHaveBeenCalledWith(storageRoot)
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  it('keeps an active cross-session storage collision on the existing canonical row', async () => {
    const sharedPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      'legacy-shared',
      'result.txt'
    )
    await writeManagedFile(sharedPath, 'shared result')
    await repository.syncSession(
      createSession({
        artifacts: [
          { id: 'artifact-a', kind: 'managed-file', path: sharedPath, name: 'result.txt' }
        ]
      })
    )
    const duplicateSession = createSession({
      id: 'session-b',
      artifacts: [{ id: 'artifact-b', kind: 'managed-file', path: sharedPath, name: 'result.txt' }]
    })

    await expect(repository.syncSession(duplicateSession)).resolves.toEqual([])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      artifactCount: 1,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: 'session-b' },
        limit: 20
      })
    ).resolves.toMatchObject({ items: [], totalCount: 0 })

    await repository.softDeleteSession(PROJECT_ID, SESSION_ID)
    await expect(repository.syncSession(duplicateSession)).resolves.toEqual(['artifact'])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      artifactCount: 1,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: 'session-b' },
        limit: 20
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ sourceFileId: 'artifact-b' })],
      totalCount: 1
    })
  })

  it('skips pending uploads and artifacts during migration', async () => {
    const pendingArtifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      '.pending',
      'result.txt'
    )
    const pendingUploadPath = join(storageRoot, 'uploads', '.pending', 'input.csv')
    await Promise.all([
      writeManagedFile(pendingArtifactPath, 'pending result'),
      writeManagedFile(pendingUploadPath, 'pending upload')
    ])

    await repository.syncSession(
      createSession({
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-pending',
                sessionId: PENDING_UPLOAD_SESSION_ID,
                name: 'input.csv',
                originalName: 'input.csv',
                path: pendingUploadPath,
                size: 14
              }
            ],
            createdAt: 1,
            updatedAt: 2
          }
        ],
        artifacts: [
          {
            id: 'artifact-pending',
            kind: 'managed-file',
            path: pendingArtifactPath,
            name: 'result.txt'
          }
        ]
      })
    )

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 0,
      isIndexComplete: true
    })
  })

  it('skips absolute paths outside the managed roots', async () => {
    const outsidePath = join(storageRoot, 'outside.txt')
    await writeManagedFile(outsidePath, 'outside')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await repository.syncSession(
        createSession({
          artifacts: [
            { id: 'artifact-outside', kind: 'managed-file', path: outsidePath, name: 'outside.txt' }
          ]
        })
      )
    } finally {
      warn.mockRestore()
    }

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 0,
      isIndexComplete: true
    })
  })

  it.skipIf(process.platform === 'win32')(
    'skips a managed-root symlink that resolves outside storage',
    async () => {
      const outsidePath = join(storageRoot, 'outside.txt')
      const linkedPath = join(storageRoot, 'artifacts', 'default-project', 'linked.txt')
      await writeManagedFile(outsidePath, 'outside')
      await mkdir(dirname(linkedPath), { recursive: true })
      await symlink(outsidePath, linkedPath)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      try {
        await repository.syncSession(
          createSession({
            artifacts: [
              { id: 'artifact-linked', kind: 'managed-file', path: linkedPath, name: 'linked.txt' }
            ]
          })
        )
      } finally {
        warn.mockRestore()
      }

      await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
        totalCount: 0,
        isIndexComplete: true
      })
    }
  )

  it('soft-deletes and restores every file owned by a session', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'result.txt'
          }
        ]
      })
    )

    const token = await repository.softDeleteSession(PROJECT_ID, SESSION_ID)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(0)

    await repository.restoreSession(PROJECT_ID, SESSION_ID, token)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(1)
  })

  it('soft-deletes and restores every indexed session in a project', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        artifacts: [
          { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
        ]
      })
    )

    const token = await repository.softDeleteProject(PROJECT_ID)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(0)

    await repository.restoreProject(PROJECT_ID, token)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(1)
  })

  it('preserves incomplete state when session and project deletion are compensated', async () => {
    const sessionMissingPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'missing-session.txt'
    )
    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'missing-session',
            kind: 'managed-file',
            path: sessionMissingPath,
            name: 'missing-session.txt'
          }
        ]
      })
    )
    expect((await repository.getOverview(PROJECT_ID)).isIndexComplete).toBe(false)

    const sessionToken = await repository.softDeleteSession(PROJECT_ID, SESSION_ID)
    await repository.restoreSession(PROJECT_ID, SESSION_ID, sessionToken)
    expect((await repository.getOverview(PROJECT_ID)).isIndexComplete).toBe(false)

    const projectSessionId = 'session-2'
    const projectMissingPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      projectSessionId,
      'message-1',
      'missing-project.txt'
    )
    await repository.syncSession(
      createSession({
        id: projectSessionId,
        artifacts: [
          {
            id: 'missing-project',
            kind: 'managed-file',
            path: projectMissingPath,
            name: 'missing-project.txt'
          }
        ]
      })
    )

    const projectToken = await repository.softDeleteProject(PROJECT_ID)
    await repository.restoreProject(PROJECT_ID, projectToken)
    expect((await repository.getOverview(PROJECT_ID)).isIndexComplete).toBe(false)
  })

  it('does not revive stale file rows when a session deletion is compensated', async () => {
    const oldPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'old.txt'
    )
    const currentPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-2',
      'current.txt'
    )
    await Promise.all([writeManagedFile(oldPath, 'old'), writeManagedFile(currentPath, 'current')])
    await repository.syncSession(
      createSession({
        filesRevision: 1,
        artifacts: [{ id: 'old', kind: 'managed-file', path: oldPath, name: 'old.txt' }]
      })
    )
    await repository.syncSession(
      createSession({
        filesRevision: 2,
        artifacts: [{ id: 'current', kind: 'managed-file', path: currentPath, name: 'current.txt' }]
      })
    )

    const token = await repository.softDeleteSession(PROJECT_ID, SESSION_ID)
    await repository.restoreSession(PROJECT_ID, SESSION_ID, token)

    const files = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(files.items.map((file) => file.name)).toEqual(['current.txt'])
  })

  it('updates file ordering metadata when an indexed file changes revision', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        filesRevision: 1,
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'result.txt',
            mtimeMs: 100
          }
        ]
      })
    )
    const changedSources = await repository.syncSession(
      createSession({
        filesRevision: 2,
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'result.txt',
            mtimeMs: 900
          }
        ]
      })
    )
    expect(changedSources).toEqual(['artifact'])

    const page = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(page.items[0].sortAtMs).toBe(900)
  })

  it('indexes artifacts whose filesystem modification time has fractional milliseconds', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')

    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'result.txt',
            mtimeMs: 1_784_516_769_248.2927
          }
        ]
      })
    )

    const page = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(page.items[0].sortAtMs).toBe(1_784_516_769_248)
  })

  it('force rebuilds missing rows even when the revision ledger matches', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    const session = createSession({
      artifacts: [
        { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
      ]
    })
    await repository.syncSession(session)
    await client.managedFile.deleteMany({ where: { projectId: PROJECT_ID } })

    await repository.syncSession(session, { force: true })

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 1 })
  })

  it('keeps artifact group ordering stable when only uploads change', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    const uploadPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    await writeManagedFile(artifactPath, 'result')
    await writeManagedFile(uploadPath, 'a,b')
    const artifact = {
      id: 'artifact-1',
      kind: 'managed-file' as const,
      path: artifactPath,
      name: 'result.txt',
      mtimeMs: 100
    }
    await repository.syncSession(
      createSession({ filesRevision: 1, updatedAt: 200, artifacts: [artifact] })
    )

    const changedSources = await repository.syncSession(
      createSession({
        filesRevision: 2,
        updatedAt: 900,
        artifacts: [artifact],
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-1',
                sessionId: SESSION_ID,
                name: 'input.csv',
                originalName: 'input.csv',
                path: uploadPath,
                size: 3
              }
            ],
            createdAt: 100,
            updatedAt: 900
          }
        ]
      })
    )

    expect(changedSources).toEqual(['upload'])
    await expect(
      client.managedFileSessionSync.findUniqueOrThrow({
        where: { projectId_sessionId: { projectId: PROJECT_ID, sessionId: SESSION_ID } },
        select: { groupSortAtMs: true }
      })
    ).resolves.toEqual({ groupSortAtMs: 200n })
  })

  it('paginates equal-sort files without duplicates and rejects cross-collection cursors', async () => {
    const artifacts = await Promise.all(
      ['a', 'b', 'c'].map(async (id) => {
        const path = join(
          storageRoot,
          'artifacts',
          'default-project',
          SESSION_ID,
          'message-1',
          `${id}.txt`
        )
        await writeManagedFile(path, id)
        return { id, kind: 'managed-file' as const, path, name: `${id}.txt`, mtimeMs: 100 }
      })
    )
    await repository.syncSession(createSession({ artifacts }))

    const first = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 2
    })
    const second = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      cursor: first.nextCursor,
      limit: 2
    })

    expect(first.totalCount).toBe(3)
    expect(first.nextCursor).toBeDefined()
    expect(new Set([...first.items, ...second.items].map((file) => file.id)).size).toBe(3)
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'uploads' },
        cursor: first.nextCursor,
        limit: 2
      })
    ).rejects.toThrow(/cursor.*collection/i)
  })

  it('paginates artifact session groups with a separate cursor', async () => {
    for (const sessionId of ['session-a', 'session-b']) {
      const path = join(
        storageRoot,
        'artifacts',
        'default-project',
        sessionId,
        'message-1',
        'result.txt'
      )
      await writeManagedFile(path, sessionId)
      await repository.syncSession(
        createSession({
          id: sessionId,
          updatedAt: 1_710_000_001_000,
          artifacts: [
            {
              id: `artifact-${sessionId}`,
              kind: 'managed-file',
              path,
              name: 'result.txt'
            }
          ]
        })
      )
    }

    const first = await repository.listArtifactGroups({ projectId: PROJECT_ID, limit: 1 })
    const second = await repository.listArtifactGroups({
      projectId: PROJECT_ID,
      cursor: first.nextCursor,
      limit: 1
    })

    expect(first.totalCount).toBe(2)
    expect(first.nextCursor).toBeDefined()
    expect(new Set([...first.items, ...second.items].map((group) => group.sessionId))).toEqual(
      new Set(['session-a', 'session-b'])
    )
  })

  it('indexes readable files while retrying an unreadable file from the same session', async () => {
    const uploadPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const missingArtifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'later.txt'
    )
    await writeManagedFile(uploadPath, 'a,b')
    const session = createSession({
      messages: [
        {
          id: 'message-user',
          role: 'user',
          content: 'Analyze',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: SESSION_ID,
              name: 'input.csv',
              originalName: 'input.csv',
              path: uploadPath,
              size: 3
            }
          ],
          createdAt: 100,
          updatedAt: 200
        }
      ],
      artifacts: [
        {
          id: 'artifact-later',
          kind: 'managed-file',
          path: missingArtifactPath,
          name: 'later.txt'
        }
      ]
    })

    await expect(repository.syncSession(session)).resolves.toEqual(['upload'])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      uploadCount: 1,
      artifactCount: 0,
      isIndexComplete: false
    })

    await writeManagedFile(missingArtifactPath, 'ready')
    await expect(repository.syncSession(session)).resolves.toEqual(['artifact'])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 2,
      uploadCount: 1,
      artifactCount: 1,
      isIndexComplete: true
    })
  })

  it('reports incomplete until a missing file can be indexed', async () => {
    const missingPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'later.txt'
    )
    const session = createSession({
      artifacts: [
        { id: 'artifact-later', kind: 'managed-file', path: missingPath, name: 'later.txt' }
      ]
    })

    await expect(repository.syncSession(session)).resolves.toEqual([])
    expect((await repository.getOverview(PROJECT_ID)).isIndexComplete).toBe(false)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(0)

    await writeManagedFile(missingPath, 'ready')
    await repository.syncSession(session)
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      isIndexComplete: true
    })
  })

  it('reports incomplete when index access fails before the revision fast-path', async () => {
    let shouldFail = true
    const recoveringRepository = new ManagedFileIndexRepository(async () => {
      if (shouldFail) throw new Error('database unavailable')
      return client
    }, storageRoot)
    const session = createSession()

    await expect(recoveringRepository.syncSession(session)).rejects.toThrow('database unavailable')
    shouldFail = false

    await expect(recoveringRepository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: false
    })
  })

  it('soft-deletes indexed sessions that are absent from a complete startup scan', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        artifacts: [
          { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
        ]
      })
    )

    await repository.reconcileActiveSessions([])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
  })

  it('reports an incomplete index until failed startup reconciliation succeeds', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        artifacts: [
          { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
        ]
      })
    )
    const softDelete = vi
      .spyOn(repository, 'softDeleteSession')
      .mockRejectedValueOnce(new Error('database busy'))

    await expect(repository.reconcileActiveSessions([])).rejects.toThrow('database busy')
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      isIndexComplete: false
    })

    softDelete.mockRestore()
    await repository.reconcileActiveSessions([])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 0,
      isIndexComplete: true
    })
  })

  it('clears an incomplete session after a complete scan confirms its JSON is gone', async () => {
    const missingPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'missing.txt'
    )
    await expect(
      repository.syncSession(
        createSession({
          artifacts: [
            { id: 'artifact-missing', kind: 'managed-file', path: missingPath, name: 'missing.txt' }
          ]
        })
      )
    ).resolves.toEqual([])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: false
    })

    await repository.reconcileActiveSessions([])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: true
    })
  })

  it('canonicalizes duplicate legacy ids that point at the same storage path', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'duplicate.txt'
    )
    await writeManagedFile(artifactPath, 'one file')
    const artifacts = [
      { id: 'legacy-a', kind: 'managed-file' as const, path: artifactPath, name: 'duplicate.txt' },
      { id: 'legacy-b', kind: 'managed-file' as const, path: artifactPath, name: 'duplicate.txt' }
    ]

    await repository.syncSession(
      createSession({
        artifacts
      })
    )

    const uploadPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    await writeManagedFile(uploadPath, 'a,b')
    const changedSources = await repository.syncSession(
      createSession({
        filesRevision: 2,
        artifacts,
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-1',
                sessionId: SESSION_ID,
                name: 'input.csv',
                originalName: 'input.csv',
                path: uploadPath,
                size: 3
              }
            ],
            createdAt: 100,
            updatedAt: 200
          }
        ]
      })
    )
    expect(changedSources).toEqual(['upload'])

    const page = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0].sourceFileId).toBe('legacy-b')
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      artifactCount: 1,
      isIndexComplete: true
    })
  })

  it('rejects an empty session scope instead of returning every project artifact', async () => {
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: '' },
        limit: 24
      })
    ).rejects.toThrow(/sessionId.*required/)
  })

  it('rejects an unknown collection kind at the runtime boundary', async () => {
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'bogus' }
      } as unknown as Parameters<ManagedFileIndexRepository['listFiles']>[0])
    ).rejects.toThrow(/collection.*invalid/)
  })
})

const writeManagedFile = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}
