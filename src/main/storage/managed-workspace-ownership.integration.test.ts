import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: true }
}))

import type { PersistedChatSession } from '../../shared/session-persistence'
import { createAcpCreateSessionWorkflow } from '../acp/create-session-workflow'
import { createManagedSessionWorkspaceCapability } from '../acp/managed-session-workspace'
import { SessionPersistenceDeletionOwner } from '../session-persistence/deletion-owner'
import { initDataRoot } from '../storage-root'
import {
  finalizeManagedWorkspaceOwnership,
  initializeManagedWorkspaceOwnership,
  markManagedProjectWorkspacesRetained,
  markManagedWorkspaceRetained,
  readManagedWorkspaceOwnership,
  reconcileProvisionalManagedWorkspaces,
  removeManagedWorkspaceOwnership,
  restoreManagedProjectWorkspacesActive,
  restoreManagedWorkspaceActive
} from './managed-workspace-ownership'
import { computeStorageUsageWithOwnership } from './usage-ownership'

const roots: string[] = []

const createDeletionOwner = (
  liveSessions: Map<string, PersistedChatSession>,
  options: {
    deleteSessionError?: Error
    deleteProjectSessionsError?: Error
    markRetainedErrorAfterWrite?: Error
    projectScanComplete?: boolean
  } = {}
): SessionPersistenceDeletionOwner =>
  new SessionPersistenceDeletionOwner({
    repository: {
      getProjectSessionDeletionState: async () => 'live',
      loadProjectWithDiagnostics: async (projectId: string) => ({
        sessions: [...liveSessions.values()].filter((session) => session.projectId === projectId),
        isComplete: options.projectScanComplete ?? true
      }),
      loadCommittedProjectWithDiagnostics: async (projectId: string) => ({
        sessions: [...liveSessions.values()].filter((session) => session.projectId === projectId),
        isComplete: true
      }),
      loadSessionWithDiagnostics: async (_projectId: string, sessionId: string) => ({
        status: 'found',
        session: liveSessions.get(sessionId)!
      }),
      deleteSession: async (_projectId: string, sessionId: string) => {
        if (options.deleteSessionError) throw options.deleteSessionError
        liveSessions.delete(sessionId)
      },
      deleteProjectSessions: async (projectId: string) => {
        if (options.deleteProjectSessionsError) throw options.deleteProjectSessionsError
        for (const [sessionId, session] of liveSessions) {
          if (session.projectId === projectId) liveSessions.delete(sessionId)
        }
      }
    } as never,
    fileIndex: {
      softDeleteSession: vi.fn().mockResolvedValue({}),
      restoreSession: vi.fn().mockResolvedValue(undefined),
      softDeleteProject: vi.fn().mockResolvedValue({}),
      markReconciliationIncomplete: vi.fn()
    } as never,
    stateOwner: {
      metadataSnapshot: () => ({ sessions: [...liveSessions.values()] }),
      removeProject: vi.fn()
    } as never,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    assertArchiveMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifySessionsDeleted: vi.fn().mockResolvedValue(undefined),
    workspaceOwnership: {
      reconcileProvisional: vi.fn().mockResolvedValue(undefined),
      markProjectRetained: (projectId) => markManagedProjectWorkspacesRetained(projectId),
      restoreProjectActive: (projectId, directories) =>
        restoreManagedProjectWorkspacesActive(projectId, directories),
      markRetained: async (session) => {
        const retained = await markManagedWorkspaceRetained(session)
        if (options.markRetainedErrorAfterWrite) throw options.markRetainedErrorAfterWrite
        return retained
      },
      restoreActive: (session) => restoreManagedWorkspaceActive(session)
    }
  })

afterEach(async () => {
  initDataRoot(undefined)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed workspace ownership', () => {
  it('keeps Project and Session identity after the live Session record is gone', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-ownership-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const liveSessions = new Map<string, PersistedChatSession>()
    const workflow = createAcpCreateSessionWorkflow(
      {
        createSession: async (request) => {
          const now = Date.now()
          liveSessions.set('session-1', {
            id: 'session-1',
            projectId: request.projectId!,
            title: 'Session',
            cwd: request.cwd!,
            status: 'idle',
            messages: [],
            createdAt: now,
            updatedAt: now + 1_000
          })
          return { sessionId: 'session-1', cwd: request.cwd }
        },
        deleteSession: async () => undefined
      },
      {
        workspaces: createManagedSessionWorkspaceCapability({
          resolveRoot: () => dataRoot,
          createId: () => 'workspace-1'
        }),
        withDataRootWrite: (write) => write()
      }
    )

    await workflow.create({ projectId: 'project-1' })
    const deletion = createDeletionOwner(liveSessions)

    await deletion.deleteSession('project-1', 'session-1')

    const usage = await computeStorageUsageWithOwnership(dataRoot)
    const workspace = usage.categories.find(({ key }) => key === 'workspaces')?.children?.[0]

    expect(workspace).toMatchObject({
      name: 'workspace-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      retainedAfterDelete: true
    })
    expect(workspace?.lastUsedAt).toBeGreaterThan(workspace?.createdAt ?? 0)
    expect(liveSessions).toEqual(new Map())
  })

  it('does not adopt an unproven direct child workspace during historical Session deletion', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-backfill-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'legacy-workspace')
    await mkdir(cwd, { recursive: true })
    const liveSessions = new Map<string, PersistedChatSession>([
      [
        'legacy-session',
        {
          id: 'legacy-session',
          projectId: 'legacy-project',
          title: 'Legacy Session',
          cwd,
          status: 'idle',
          messages: [],
          createdAt: 10,
          updatedAt: 20
        }
      ]
    ])

    await createDeletionOwner(liveSessions).deleteProjectSessions(
      'legacy-project',
      (_sessionIds, operation) => operation()
    )

    const usage = await computeStorageUsageWithOwnership(dataRoot)
    expect(usage.categories.find(({ key }) => key === 'workspaces')?.children?.[0]).toEqual({
      name: 'legacy-workspace',
      bytes: 0
    })
  })

  it('leaves an external Session directory unowned and untouched during Project deletion', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-external-data-'))
    const externalCwd = await mkdtemp(join(tmpdir(), 'managed-workspace-external-cwd-'))
    roots.push(dataRoot, externalCwd)
    initDataRoot(dataRoot)
    const liveSessions = new Map<string, PersistedChatSession>([
      [
        'external-session',
        {
          id: 'external-session',
          projectId: 'project-1',
          title: 'External Session',
          cwd: externalCwd,
          status: 'idle',
          messages: [],
          createdAt: 10,
          updatedAt: 20
        }
      ]
    ])

    await createDeletionOwner(liveSessions).deleteProjectSessions(
      'project-1',
      (_sessionIds, operation) => operation()
    )

    await expect(readdir(externalCwd)).resolves.toEqual([])
  })

  it('allows Session deletion after its managed workspace was removed independently', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-missing-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-1')
    await mkdir(cwd, { recursive: true })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session',
      cwd,
      status: 'idle',
      messages: [],
      createdAt: 10,
      updatedAt: 20
    }
    const liveSessions = new Map([[session.id, session]])
    await initializeManagedWorkspaceOwnership(cwd, session.projectId, session.createdAt, dataRoot)
    await finalizeManagedWorkspaceOwnership(cwd, session.id, session.updatedAt, dataRoot)
    await rm(cwd, { recursive: true })

    await expect(computeStorageUsageWithOwnership(dataRoot)).resolves.toMatchObject({
      categories: expect.arrayContaining([{ key: 'workspaces', bytes: 0 }])
    })

    await createDeletionOwner(liveSessions).deleteSession(session.projectId, session.id)
    expect(liveSessions).toEqual(new Map())
    await expect(readdir(join(dataRoot, 'workspaces', '.ownership'))).resolves.toEqual([])
  })

  it('deletes a branch that shares its source Session managed workspace', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-shared-branch-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-1')
    await mkdir(cwd, { recursive: true })
    const source = {
      id: 'source-session',
      projectId: 'project-1',
      title: 'Source Session',
      cwd,
      status: 'idle' as const,
      messages: [],
      createdAt: 10,
      updatedAt: 20
    }
    const branch = {
      ...source,
      id: 'branch-session',
      title: 'Branch Session',
      createdAt: 30,
      updatedAt: 40
    }
    const liveSessions = new Map<string, PersistedChatSession>([
      [source.id, source],
      [branch.id, branch]
    ])
    await initializeManagedWorkspaceOwnership(cwd, source.projectId, source.createdAt, dataRoot)
    await finalizeManagedWorkspaceOwnership(cwd, source.id, source.updatedAt, dataRoot)

    await expect(
      createDeletionOwner(liveSessions).deleteSession(branch.projectId, branch.id)
    ).resolves.toEqual({ receiptKind: 'ordinary' })

    expect([...liveSessions.keys()]).toEqual([source.id])
    await expect(readManagedWorkspaceOwnership(cwd, dataRoot)).resolves.toMatchObject({
      sessionId: source.id,
      retainedAfterDelete: false
    })
  })

  it('retains owned workspaces when deleting an incomplete Project catalog', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-incomplete-project-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const readableCwd = join(dataRoot, 'workspaces', 'workspace-readable')
    const unreadableCwd = join(dataRoot, 'workspaces', 'workspace-unreadable')
    await mkdir(readableCwd, { recursive: true })
    await mkdir(unreadableCwd, { recursive: true })
    const readableSession: PersistedChatSession = {
      id: 'readable-session',
      projectId: 'project-1',
      title: 'Readable Session',
      cwd: readableCwd,
      status: 'idle',
      messages: [],
      createdAt: 10,
      updatedAt: 20
    }
    const liveSessions = new Map([[readableSession.id, readableSession]])
    await initializeManagedWorkspaceOwnership(readableCwd, 'project-1', 10, dataRoot)
    await finalizeManagedWorkspaceOwnership(readableCwd, readableSession.id, 20, dataRoot)
    await initializeManagedWorkspaceOwnership(unreadableCwd, 'project-1', 30, dataRoot)
    await finalizeManagedWorkspaceOwnership(unreadableCwd, 'unreadable-session', 40, dataRoot)

    await createDeletionOwner(liveSessions, { projectScanComplete: false }).deleteProjectSessions(
      'project-1',
      (_sessionIds, operation) => operation()
    )

    await expect(readManagedWorkspaceOwnership(readableCwd, dataRoot)).resolves.toMatchObject({
      retainedAfterDelete: true
    })
    await expect(readManagedWorkspaceOwnership(unreadableCwd, dataRoot)).resolves.toMatchObject({
      retainedAfterDelete: true
    })
  })

  it('restores Project-scanned ownership when incomplete authority deletion fails', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-incomplete-rollback-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-unreadable')
    await mkdir(cwd, { recursive: true })
    await initializeManagedWorkspaceOwnership(cwd, 'project-1', 10, dataRoot)
    await finalizeManagedWorkspaceOwnership(cwd, 'unreadable-session', 20, dataRoot)

    await expect(
      createDeletionOwner(new Map(), {
        projectScanComplete: false,
        deleteProjectSessionsError: new Error('Project Session authority delete failed')
      }).deleteProjectSessions('project-1', (_sessionIds, operation) => operation())
    ).rejects.toThrow('Project Session authority delete failed')

    await expect(readManagedWorkspaceOwnership(cwd, dataRoot)).resolves.toMatchObject({
      retainedAfterDelete: false
    })
  })

  it('removes a provisional workspace left by an earlier process', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-provisional-orphan-'))
    roots.push(dataRoot)
    const workspacesRoot = join(dataRoot, 'workspaces')
    const cwd = join(workspacesRoot, 'workspace-1')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'partial-output.txt'), 'orphaned')
    await initializeManagedWorkspaceOwnership(cwd, 'project-1', 10, dataRoot)

    await reconcileProvisionalManagedWorkspaces([], 20, dataRoot)

    await expect(readdir(workspacesRoot)).resolves.toEqual(['.ownership'])
    await expect(readdir(join(workspacesRoot, '.ownership'))).resolves.toEqual([])
  })

  it('removes a finalized workspace with no authoritative Session', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-finalized-orphan-'))
    roots.push(dataRoot)
    const workspacesRoot = join(dataRoot, 'workspaces')
    const cwd = join(workspacesRoot, 'workspace-1')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'partial-output.txt'), 'orphaned')
    await initializeManagedWorkspaceOwnership(cwd, 'project-1', 10, dataRoot)
    await finalizeManagedWorkspaceOwnership(cwd, 'session-1', 15, dataRoot)

    await reconcileProvisionalManagedWorkspaces([], 20, dataRoot)

    await expect(readdir(workspacesRoot)).resolves.toEqual(['.ownership'])
    await expect(readdir(join(workspacesRoot, '.ownership'))).resolves.toEqual([])
  })

  it('preserves a finalized workspace referenced by another Session', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-finalized-shared-'))
    roots.push(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-1')
    await mkdir(cwd, { recursive: true })
    await initializeManagedWorkspaceOwnership(cwd, 'project-1', 10, dataRoot)
    await finalizeManagedWorkspaceOwnership(cwd, 'source-session', 15, dataRoot)
    const branch = {
      id: 'branch-session',
      projectId: 'project-1',
      cwd,
      updatedAt: 30
    }

    await reconcileProvisionalManagedWorkspaces([branch], 20, dataRoot)

    await expect(readManagedWorkspaceOwnership(cwd, dataRoot)).resolves.toMatchObject({
      sessionId: 'source-session',
      retainedAfterDelete: false
    })
  })

  it('recovers a provisional durable temp receipt before startup cleanup', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-provisional-temp-'))
    roots.push(dataRoot)
    const workspacesRoot = join(dataRoot, 'workspaces')
    const ownershipDirectory = join(workspacesRoot, '.ownership')
    const cwd = join(workspacesRoot, 'workspace-1')
    await mkdir(cwd, { recursive: true })
    await mkdir(ownershipDirectory)
    await writeFile(
      join(ownershipDirectory, 'workspace-1.json.1700000000000-1.tmp'),
      `${JSON.stringify({
        version: 1,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        createdAt: 10,
        lastUsedAt: 10,
        retainedAfterDelete: false
      })}\n`
    )

    await reconcileProvisionalManagedWorkspaces([], 20, dataRoot)

    await expect(readdir(workspacesRoot)).resolves.toEqual(['.ownership'])
    await expect(readdir(ownershipDirectory)).resolves.toEqual([])
  })

  it('finalizes a provisional receipt referenced by an authoritative Session', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-provisional-session-'))
    roots.push(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-1')
    await mkdir(cwd, { recursive: true })
    await initializeManagedWorkspaceOwnership(cwd, 'project-1', 10, dataRoot)
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session',
      cwd,
      status: 'idle',
      messages: [],
      createdAt: 10,
      updatedAt: 30
    }

    await reconcileProvisionalManagedWorkspaces([session], 20, dataRoot)

    await expect(readManagedWorkspaceOwnership(cwd, dataRoot)).resolves.toMatchObject({
      projectId: 'project-1',
      sessionId: 'session-1',
      lastUsedAt: 30
    })
  })

  it('preserves a provisional workspace created after the recovery cutoff', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-current-provisional-'))
    roots.push(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-1')
    await mkdir(cwd, { recursive: true })
    await initializeManagedWorkspaceOwnership(cwd, 'project-1', 20, dataRoot)

    await reconcileProvisionalManagedWorkspaces([], 20, dataRoot)

    await expect(readManagedWorkspaceOwnership(cwd, dataRoot)).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      projectId: 'project-1'
    })
  })

  it('does not remove an external directory through a symlinked workspaces root', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-allocation-root-'))
    const externalWorkspaces = await mkdtemp(
      join(tmpdir(), 'managed-workspace-allocation-external-')
    )
    roots.push(dataRoot, externalWorkspaces)
    initDataRoot(dataRoot)
    await mkdir(join(externalWorkspaces, 'workspace-1'))
    await writeFile(join(externalWorkspaces, 'workspace-1', 'user-data.txt'), 'keep')
    await symlink(
      externalWorkspaces,
      join(dataRoot, 'workspaces'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const workspaces = createManagedSessionWorkspaceCapability({
      resolveRoot: () => dataRoot,
      createId: () => 'workspace-1'
    })

    await expect(workspaces.acquire({ projectId: 'project-1' })).rejects.toThrow(/workspace/i)

    await expect(readdir(externalWorkspaces)).resolves.toEqual(['workspace-1'])
    await expect(readdir(join(externalWorkspaces, 'workspace-1'))).resolves.toEqual([
      'user-data.txt'
    ])
  })

  it('does not follow a symlinked ownership directory for receipt writes or removals', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-linked-ownership-'))
    const externalOwnership = await mkdtemp(join(tmpdir(), 'managed-workspace-external-ownership-'))
    roots.push(dataRoot, externalOwnership)
    initDataRoot(dataRoot)
    const workspacesRoot = join(dataRoot, 'workspaces')
    const cwd = join(workspacesRoot, 'workspace-1')
    await mkdir(cwd, { recursive: true })
    await symlink(
      externalOwnership,
      join(workspacesRoot, '.ownership'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      initializeManagedWorkspaceOwnership(cwd, 'project-1', 10, dataRoot)
    ).rejects.toThrow(/ownership/i)
    await writeFile(join(externalOwnership, 'workspace-1.json'), 'external receipt')

    await expect(removeManagedWorkspaceOwnership(cwd, dataRoot)).resolves.toBeUndefined()
    await expect(readdir(externalOwnership)).resolves.toEqual(['workspace-1.json'])
  })

  it('does not follow a symlinked workspaces root for receipt writes or removals', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-linked-root-'))
    const externalWorkspaces = await mkdtemp(join(tmpdir(), 'managed-workspace-external-root-'))
    roots.push(dataRoot, externalWorkspaces)
    initDataRoot(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-1')
    await mkdir(join(externalWorkspaces, 'workspace-1'))
    await symlink(
      externalWorkspaces,
      join(dataRoot, 'workspaces'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      initializeManagedWorkspaceOwnership(cwd, 'project-1', 10, dataRoot)
    ).rejects.toThrow(/workspace/i)
    await mkdir(join(externalWorkspaces, '.ownership'))
    await writeFile(join(externalWorkspaces, '.ownership', 'workspace-1.json'), 'external receipt')

    await expect(removeManagedWorkspaceOwnership(cwd, dataRoot)).resolves.toBeUndefined()
    await expect(readdir(join(externalWorkspaces, '.ownership'))).resolves.toEqual([
      'workspace-1.json'
    ])
  })

  it('restores active ownership when Session authority deletion fails', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-delete-failure-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-1')
    await mkdir(cwd, { recursive: true })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session',
      cwd,
      status: 'idle',
      messages: [],
      createdAt: 10,
      updatedAt: 20
    }
    const liveSessions = new Map([[session.id, session]])
    await initializeManagedWorkspaceOwnership(cwd, session.projectId, session.createdAt, dataRoot)
    await finalizeManagedWorkspaceOwnership(cwd, session.id, session.updatedAt, dataRoot)

    await expect(
      createDeletionOwner(liveSessions, {
        deleteSessionError: new Error('Session authority delete failed')
      }).deleteSession(session.projectId, session.id)
    ).rejects.toThrow('Session authority delete failed')

    const usage = await computeStorageUsageWithOwnership(dataRoot)
    expect(usage.categories.find(({ key }) => key === 'workspaces')?.children?.[0]).toMatchObject({
      projectId: 'project-1',
      sessionId: 'session-1',
      retainedAfterDelete: false
    })
  })

  it('restores active ownership when Session retention throws after writing', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-retain-failure-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-1')
    await mkdir(cwd, { recursive: true })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session',
      cwd,
      status: 'idle',
      messages: [],
      createdAt: 10,
      updatedAt: 20
    }
    const liveSessions = new Map([[session.id, session]])
    await initializeManagedWorkspaceOwnership(cwd, session.projectId, session.createdAt, dataRoot)
    await finalizeManagedWorkspaceOwnership(cwd, session.id, session.updatedAt, dataRoot)

    await expect(
      createDeletionOwner(liveSessions, {
        markRetainedErrorAfterWrite: new Error('Retention directory sync failed')
      }).deleteSession(session.projectId, session.id)
    ).rejects.toThrow('Retention directory sync failed')

    const usage = await computeStorageUsageWithOwnership(dataRoot)
    expect(usage.categories.find(({ key }) => key === 'workspaces')?.children?.[0]).toMatchObject({
      retainedAfterDelete: false
    })
    expect(liveSessions.has(session.id)).toBe(true)
  })

  it('restores active ownership when Project Session authority deletion fails', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-project-delete-failure-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const liveSessions = new Map<string, PersistedChatSession>()
    const workflow = createAcpCreateSessionWorkflow(
      {
        createSession: async (request) => {
          const session: PersistedChatSession = {
            id: 'session-1',
            projectId: request.projectId!,
            title: 'Session',
            cwd: request.cwd!,
            status: 'idle',
            messages: [],
            createdAt: 10,
            updatedAt: 20
          }
          liveSessions.set(session.id, session)
          return { sessionId: session.id, cwd: session.cwd }
        },
        deleteSession: async () => undefined
      },
      {
        workspaces: createManagedSessionWorkspaceCapability({
          resolveRoot: () => dataRoot,
          createId: () => 'workspace-1'
        }),
        withDataRootWrite: (write) => write()
      }
    )
    await workflow.create({ projectId: 'project-1' })

    await expect(
      createDeletionOwner(liveSessions, {
        deleteProjectSessionsError: new Error('Project Session authority delete failed')
      }).deleteProjectSessions('project-1', (_sessionIds, operation) => operation())
    ).rejects.toThrow('Project Session authority delete failed')

    const usage = await computeStorageUsageWithOwnership(dataRoot)
    expect(usage.categories.find(({ key }) => key === 'workspaces')?.children?.[0]).toMatchObject({
      projectId: 'project-1',
      sessionId: 'session-1',
      retainedAfterDelete: false
    })
    expect(liveSessions.has('session-1')).toBe(true)
  })

  it('restores active ownership when Project retention throws after writing', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'managed-workspace-project-retain-failure-'))
    roots.push(dataRoot)
    initDataRoot(dataRoot)
    const cwd = join(dataRoot, 'workspaces', 'workspace-1')
    await mkdir(cwd, { recursive: true })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session',
      cwd,
      status: 'idle',
      messages: [],
      createdAt: 10,
      updatedAt: 20
    }
    const liveSessions = new Map([[session.id, session]])
    await initializeManagedWorkspaceOwnership(cwd, session.projectId, session.createdAt, dataRoot)
    await finalizeManagedWorkspaceOwnership(cwd, session.id, session.updatedAt, dataRoot)

    await expect(
      createDeletionOwner(liveSessions, {
        markRetainedErrorAfterWrite: new Error('Retention directory sync failed')
      }).deleteProjectSessions(session.projectId, (_sessionIds, operation) => operation())
    ).rejects.toThrow('Retention directory sync failed')

    const usage = await computeStorageUsageWithOwnership(dataRoot)
    expect(usage.categories.find(({ key }) => key === 'workspaces')?.children?.[0]).toMatchObject({
      retainedAfterDelete: false
    })
    expect(liveSessions.has(session.id)).toBe(true)
  })
})
