import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Session encode/decode falls back to resolveDataRoot(), which reads electron's app.getPath.
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import {
  MAX_PERSISTED_SESSION_BYTES,
  SESSION_SIZE_LIMIT_ERROR_CODE,
  type PersistedChatSession,
  type PersistedToolActivity
} from '../../shared/session-persistence'
import { DurableJsonReadLimitError } from '../storage/durable-json-file'
import {
  DEV_SESSION_DIR_NAME,
  SessionRepository,
  getSessionPersistenceDir,
  loadSessionMutationAuthority
} from './repository'

let storageRoot: string | undefined
let externalRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-sessions-'))
  return storageRoot
}

const createExternalRoot = async (): Promise<string> => {
  externalRoot = await mkdtemp(join(tmpdir(), 'open-science-sessions-external-'))
  return externalRoot
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

const createPendingMcpToolActivity = (): PersistedToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: 'Run npm test',
  status: 'in_progress',
  sortIndex: 1,
  eventIds: ['tool-1-started'],
  promptMessageId: 'message-1',
  createdAt: 1710000000200,
  updatedAt: 1710000000200
})

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
  if (externalRoot) {
    await rm(externalRoot, { recursive: true, force: true })
    externalRoot = undefined
  }
})

describe('session persistence repository (per-session files)', () => {
  it('resolves recovery folders inside the managed Session tree', async () => {
    const root = await createStorageRoot()
    const repository = new SessionRepository(root)

    expect(repository.recoveryFolderPath('project-a')).toBe(join(root, 'sessions', 'project-a'))
    expect(() => repository.recoveryFolderPath('../outside')).toThrow(
      /unsafe session path segment/i
    )
  })

  it('preserves a running Session when its runtime is live before a prompt becomes active', async () => {
    const repository = new SessionRepository(await createStorageRoot(), {
      hasActiveRuntimePrompt: () => false,
      hasLiveRuntimeSession: () => true
    })
    await repository.saveSession(
      createSession({
        status: 'running',
        activeRun: { promptMessageId: 'message-1', startedAt: 1710000000200 }
      })
    )

    const loaded = await repository.loadSessionWithDiagnostics('project-a', 'session-1')

    expect(loaded).toMatchObject({
      status: 'found',
      session: {
        status: 'running',
        activeRun: { promptMessageId: 'message-1', startedAt: 1710000000200 }
      }
    })
    expect(loaded.status === 'found' ? loaded.session.resumeRecovery : undefined).toBeUndefined()
    expect(loaded.status === 'found' ? loaded.session.error : undefined).toBeUndefined()
  })

  it('persists self-healed recovery state on the next ordinary write', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    await repository.saveSession(
      createSession({
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'message-1'
        },
        messages: [
          ...createSession().messages,
          {
            id: 'response-1',
            role: 'agent',
            content: 'Completed response',
            status: 'complete',
            responseToMessageId: 'message-1',
            eventIds: [],
            createdAt: 1710000000200,
            completedAt: 1710000000300,
            updatedAt: 1710000000300
          }
        ]
      })
    )

    const restored = await repository.loadSessionWithDiagnostics('project-a', 'session-1')
    expect(restored.status).toBe('found')
    if (restored.status !== 'found') throw new Error('Expected Session to be restored.')
    expect(restored.session.resumeRecovery).toBeUndefined()
    await repository.saveSession(restored.session)

    const authority = await loadSessionMutationAuthority(repository, 'project-a', 'session-1')
    expect(authority.status).toBe('found')
    expect(
      authority.status === 'found' ? authority.session.resumeRecovery : undefined
    ).toBeUndefined()
  })

  it('preserves one immutable pre-S2 Session backup before the first initiating-Turn write', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const legacy = createSession({
      title: 'Before S2: {"initiatingTurnMessageId":"ordinary user content"}'
    })
    await repository.saveSession(legacy)
    const filePath = join(storageRoot!, 'sessions', 'project-a', 'session-1.json')
    const beforeUpgrade = await readFile(filePath, 'utf8')
    const upgraded = createSession({
      title: 'After S2',
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [
            {
              agentFrameId: 'child-frame',
              attempts: [
                {
                  id: 'attempt-1',
                  initiatingTurnMessageId: 'message-1',
                  status: 'cancelled',
                  resolvedAgent: { kind: 'main' },
                  runtimeSegmentIds: [],
                  startedAt: 1710000000001,
                  endedAt: 1710000000002,
                  cancellationReason: 'main_agent_stop'
                }
              ]
            }
          ]
        }
      }
    })

    await repository.saveSession(upgraded)
    const backupPath = `${filePath}.pre-s2-backup`
    await expect(readFile(backupPath, 'utf8')).resolves.toBe(beforeUpgrade)
    await repository.saveSession({ ...upgraded, title: 'Later S2 edit' })
    await expect(readFile(backupPath, 'utf8')).resolves.toBe(beforeUpgrade)
    await expect(readFile(filePath, 'utf8')).resolves.toContain('Later S2 edit')
  })

  it('preserves an independent immutable backup before the first execution-model snapshot write', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const legacy = createSession()
    await repository.saveSession(legacy)
    const filePath = join(storageRoot!, 'sessions', 'project-a', 'session-1.json')
    const beforeUpgrade = await readFile(filePath, 'utf8')
    const upgraded = createSession({
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [
            {
              agentFrameId: 'child-frame',
              attempts: [
                {
                  id: 'attempt-1',
                  initiatingTurnMessageId: 'message-1',
                  status: 'cancelled',
                  resolvedAgent: { kind: 'main' },
                  executionModel: {
                    frameworkId: 'opencode',
                    providerId: 'provider-a',
                    backendId: 'provider-a',
                    modelRoute: 'opencode-openai',
                    model: 'model-a',
                    reasoningEffort: 'high'
                  },
                  runtimeSegmentIds: [],
                  startedAt: 1710000000001,
                  endedAt: 1710000000002,
                  cancellationReason: 'main_agent_stop'
                }
              ]
            }
          ]
        }
      }
    })

    await repository.saveSession(upgraded)
    const backupPath = `${filePath}.pre-subagent-model-backup`
    await expect(readFile(backupPath, 'utf8')).resolves.toBe(beforeUpgrade)
    await repository.saveSession({ ...upgraded, title: 'Later model edit' })
    await expect(readFile(backupPath, 'utf8')).resolves.toBe(beforeUpgrade)
  })

  it('saves each session to sessions/<projectId>/<id>.json and loads it back', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const session = createSession({
      branchSource: {
        sessionId: 'source-session',
        agentFrameId: 'source-frame',
        messageBranchId: 'source-branch',
        headMessageId: 'source-message'
      }
    })

    await repository.saveSession(session)

    const filePath = join(storageRoot!, 'sessions', 'project-a', 'session-1.json')
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      session: PersistedChatSession
    }
    expect(raw.version).toBe(2)
    expect(raw.session.conversationGraph).toMatchObject({
      schemaVersion: 1,
      rootFrameId: 'root-frame-session-1'
    })
    expect(raw.session.branchSource).toEqual(session.branchSource)

    const { sessions } = await repository.loadAll()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Saved conversation',
      branchSource: session.branchSource,
      messages: [{ content: 'Summarize this file' }]
    })
  })

  it('round-trips raw delegated records quarantine while saving unrelated runtime owners', async () => {
    const root = await createStorageRoot()
    const repository = new SessionRepository(root)
    const filePath = join(root, 'sessions', 'project-a', 'session-1.json')
    const corruptRecords = [{ agentFrameId: 'child-frame', attempts: 'corrupt' }]
    const session = createSession({
      runtimeContext: {
        version: 1,
        revision: 4,
        plan: {
          artifactId: 'plan-1',
          artifactVersionId: 'plan-version-1',
          artifactChecksum: 'a'.repeat(64),
          approval: 'pending',
          stepStatuses: {}
        },
        delegatedWork: { records: [], messageCommands: [] },
        sideChat: {
          version: 1,
          id: 'side-chat-1',
          lifecycle: 'open',
          frameworkId: 'codex',
          historyPreamble: 'Preserve this side chat.',
          entries: [],
          createdAt: 1,
          updatedAt: 1
        }
      }
    })
    await mkdir(join(root, 'sessions', 'project-a'), { recursive: true })
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        session: {
          ...session,
          runtimeContext: {
            ...session.runtimeContext,
            delegatedWork: { records: corruptRecords, messageCommands: [] }
          }
        }
      }),
      'utf8'
    )

    const loaded = (await repository.loadAll()).sessions[0]
    expect(loaded.runtimeContext).toMatchObject({
      plan: { artifactId: 'plan-1' },
      sideChat: { id: 'side-chat-1' },
      delegatedWork: { records: [], recordsQuarantine: corruptRecords, messageCommands: [] }
    })

    await repository.saveSession({ ...loaded, title: 'Ordinary Session save' })

    const reopened = (await repository.loadAll()).sessions[0]
    expect(reopened.runtimeContext).toEqual(loaded.runtimeContext)
    expect(reopened.runtimeContext?.delegatedWork?.records).toEqual([])

    const laterCorruption = [{ agentFrameId: 'later-child', attempts: 'later-corruption' }]
    const corruptedAgain = JSON.parse(await readFile(filePath, 'utf8')) as {
      session: PersistedChatSession
    }
    corruptedAgain.session.runtimeContext = {
      ...corruptedAgain.session.runtimeContext!,
      delegatedWork: {
        ...corruptedAgain.session.runtimeContext!.delegatedWork!,
        records: laterCorruption
      } as unknown as NonNullable<
        NonNullable<PersistedChatSession['runtimeContext']>['delegatedWork']
      >
    }
    await writeFile(filePath, JSON.stringify(corruptedAgain), 'utf8')
    const twiceQuarantined = (await repository.loadAll()).sessions[0]
    expect(twiceQuarantined.runtimeContext?.delegatedWork).toMatchObject({
      records: [],
      recordsQuarantine: {
        previous: corruptRecords,
        current: laterCorruption
      }
    })

    await repository.saveSession(twiceQuarantined)
    expect((await repository.loadAll()).sessions[0].runtimeContext).toEqual(
      twiceQuarantined.runtimeContext
    )
  })

  it('keeps the Session catalog readable after a post-fence receipt save fails', async () => {
    const receiptCommitFailure = new Error('injected receipt commit failure')
    let rejectReplacement = false
    const renameFile = vi.fn((source: string, destination: string) =>
      rejectReplacement ? Promise.reject(receiptCommitFailure) : rename(source, destination)
    )
    const repository = new SessionRepository(await createStorageRoot(), { renameFile })
    const queued = createSession({
      runtimeContext: {
        version: 1,
        revision: 3,
        delegatedWork: {
          records: [],
          messageCommands: [
            {
              messageId: 'message-post-fence',
              requestId: 'e2e-child-post-fence',
              sourcePrincipal: 'child-frame\u0000child-attempt',
              canonicalDigest: 'a'.repeat(64),
              sourceFrameId: 'child-frame',
              sourceAttemptId: 'child-attempt',
              targetFrameId: 'root-frame-session-1',
              rootOriginMessageId: 'message-1',
              callerRootMessageId: 'message-1',
              rootPromptMessageId: 'root-prompt-post-fence',
              rootBranchId: 'root-branch-session-1',
              rootBranchRevision: 'root-branch-session-1:1710000000000',
              direction: 'to_parent',
              disposition: 'message',
              text: 'Trigger reliable post-fence persistence failure',
              kind: 'info',
              laneSequence: 1,
              queuedAt: 1710000000101,
              receipt: {
                status: 'queued',
                dispatchStartedAt: 1710000000102,
                dispatchEpoch: 'message-post-fence-dispatch'
              }
            }
          ]
        }
      }
    })
    await repository.saveSession(queued)
    rejectReplacement = true
    await expect(
      repository.saveSession({
        ...queued,
        runtimeContext: {
          ...queued.runtimeContext!,
          revision: 4,
          delegatedWork: {
            ...queued.runtimeContext!.delegatedWork!,
            messageCommands: queued.runtimeContext!.delegatedWork!.messageCommands!.map(
              (command) => ({
                ...command,
                receipt: {
                  status: 'accepted' as const,
                  acceptedAt: 1710000000103,
                  evidence: 'provider_prompt_accepted' as const
                }
              })
            )
          }
        }
      })
    ).rejects.toBe(receiptCommitFailure)

    await expect(repository.loadAllWithDiagnostics()).resolves.toMatchObject({
      isComplete: true,
      result: {
        sessions: [
          {
            id: queued.id,
            runtimeContext: {
              delegatedWork: {
                messageCommands: [
                  { receipt: { status: 'queued', dispatchStartedAt: 1710000000102 } }
                ]
              }
            }
          }
        ]
      }
    })
  })

  it('retries a transient Windows file-replacement denial without losing the Session save', async () => {
    const renameFile = vi
      .fn<(source: string, destination: string) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))
      .mockImplementation((source, destination) => rename(source, destination))
    const wait = vi.fn(async () => undefined)
    const repository = new SessionRepository(await createStorageRoot(), { renameFile, wait })

    await expect(repository.saveSession(createSession())).resolves.toMatchObject({ revision: 1 })

    expect(renameFile).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
    await expect(
      readFile(join(storageRoot!, 'sessions', 'project-a', 'session-1.json'), 'utf8')
    ).resolves.toContain('Saved conversation')
  })

  it('fails closed and removes the temporary Session file after persistent replacement denial', async () => {
    const failure = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    const renameFile = vi.fn(async () => Promise.reject(failure))
    const wait = vi.fn(async () => undefined)
    const repository = new SessionRepository(await createStorageRoot(), { renameFile, wait })

    await expect(repository.saveSession(createSession())).rejects.toBe(failure)

    expect(renameFile).toHaveBeenCalledTimes(6)
    expect(wait).toHaveBeenCalledTimes(5)
    await expect(readdir(join(storageRoot!, 'sessions', 'project-a'))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringContaining('.tmp')])
    )
  })

  it('recovers a valid historical Session temp when the primary is missing', async () => {
    const root = await createStorageRoot()
    const filePath = join(root, 'sessions', 'project-a', 'session-1.json')
    await new SessionRepository(root).saveSession(createSession({ title: 'Before crash' }))
    await rename(filePath, `${filePath}.1700000000000-1.tmp`)

    await expect(new SessionRepository(root).loadAll()).resolves.toMatchObject({
      sessions: [{ id: 'session-1', title: 'Before crash' }]
    })
    await expect(readdir(join(root, 'sessions', 'project-a'))).resolves.toEqual(['session-1.json'])
  })

  it('recovers a valid historical manifest temp when the primary is missing', async () => {
    const root = await createStorageRoot()
    const manifestPath = join(root, 'sessions', 'manifest.json')
    await mkdir(join(root, 'sessions'), { recursive: true })
    await writeFile(
      manifestPath,
      JSON.stringify({ version: 1, lastProjectId: 'project-a', lastSessionId: 'session-1' }),
      'utf8'
    )
    await rename(manifestPath, `${manifestPath}.1700000000000-1.tmp`)

    await expect(new SessionRepository(root).loadAll()).resolves.toMatchObject({
      manifest: { version: 1, lastSessionId: 'session-1' }
    })
    await expect(readdir(join(root, 'sessions'))).resolves.toEqual(['manifest.json'])
  })

  it('loads one session directly so callers can refresh durable state between turns', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    await repository.saveSession(createSession({ title: 'Before correction' }))

    await expect(repository.loadSession('project-a', 'session-1')).resolves.toMatchObject({
      id: 'session-1',
      title: 'Before correction'
    })

    await repository.saveSession(
      createSession({
        title: 'After correction',
        messages: [
          ...createSession().messages,
          {
            id: 'message-2',
            role: 'agent',
            content: 'Correction complete',
            status: 'complete',
            eventIds: [],
            createdAt: 1710000000200,
            updatedAt: 1710000000200
          }
        ]
      })
    )

    const refreshed = await repository.loadSession('project-a', 'session-1')
    expect(refreshed?.title).toBe('After correction')
    expect(refreshed?.messages.at(-1)?.id).toBe('message-2')
    await expect(repository.loadSession('project-a', 'missing')).resolves.toBeUndefined()
    await expect(repository.loadSessionWithDiagnostics('project-a', 'missing')).resolves.toEqual({
      status: 'missing'
    })
  })

  it('compares and advances Session revisions inside the atomic write lane', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const first = await repository.saveSession(createSession(), 0)
    expect(first.revision).toBe(1)

    await expect(
      repository.saveSession(
        createSession({ revision: 0, title: 'Stale replacement', updatedAt: 1710000000200 }),
        0
      )
    ).rejects.toMatchObject({
      code: 'session-revision-conflict',
      expectedRevision: 0,
      actualRevision: 1
    })
    await expect(repository.loadSession('project-a', 'session-1')).resolves.toMatchObject({
      revision: 1,
      title: 'Saved conversation'
    })

    await expect(
      repository.saveSession(
        { ...first, title: 'Accepted replacement', updatedAt: 1710000000300 },
        1
      )
    ).resolves.toMatchObject({ revision: 2, title: 'Accepted replacement' })
  })

  it('never writes finalized upload absolute paths into Session JSON', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const session = createSession()
    session.messages[0].uploads = [
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: 'session-1',
        name: 'input.csv',
        originalName: 'input.csv',
        path: '/Users/private/uploads/input.csv',
        size: 12,
        checksum: 'a'.repeat(64)
      }
    ]

    await repository.saveSession(session)

    const filePath = join(storageRoot!, 'sessions', 'project-a', 'session-1.json')
    const serialized = await readFile(filePath, 'utf8')
    expect(serialized).not.toContain('/Users/private/uploads/input.csv')
    expect(JSON.parse(serialized).session.messages[0].uploads[0]).toMatchObject({
      id: 'upload-1',
      versionId: 'upload-version-1',
      versionNumber: 1,
      sha256: 'a'.repeat(64)
    })
  })

  it('refuses to erase a legacy upload path before it has an immutable Version', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const session = createSession()
    session.messages[0].uploads = [
      {
        id: 'legacy-upload-1',
        sessionId: 'session-1',
        name: 'input.csv',
        originalName: 'input.csv',
        path: '/Users/private/uploads/input.csv',
        size: 12
      }
    ]

    await expect(repository.saveSession(session)).rejects.toThrow(/upgraded.*Version/i)
    await expect(
      readFile(join(storageRoot!, 'sessions', 'project-a', 'session-1.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
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

  it('reports a complete scan when corrupt files were successfully isolated', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'broken.json'), '{broken json', 'utf8')

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(true)
    expect(scan.warnings).toEqual([
      {
        kind: 'corrupt',
        projectId: 'project-a',
        fileName: 'broken.json',
        recovered: true
      }
    ])

    const nextScan = await repository.loadAllWithDiagnostics()
    expect(nextScan.warnings).toEqual(scan.warnings)
  })

  it('reports aggregate Session scan scale without exposing catalog identifiers', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectA = join(storageRoot!, 'sessions', 'project-a')
    const projectB = join(storageRoot!, 'sessions', 'project-b')
    const rawA = JSON.stringify({
      version: 2,
      session: createSession({ id: 'private-session-a' })
    })
    const rawB = JSON.stringify({
      version: 2,
      session: createSession({ id: 'private-session-b', projectId: 'project-b' })
    })
    await mkdir(projectA, { recursive: true })
    await mkdir(projectB, { recursive: true })
    await writeFile(join(projectA, 'private-session-a.json'), rawA, 'utf8')
    await writeFile(join(projectB, 'private-session-b.json'), rawB, 'utf8')

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.scanMetrics).toEqual({
      projectDirectoryCount: 2,
      sessionFileCount: 2,
      sessionBytes: Buffer.byteLength(rawA, 'utf8') + Buffer.byteLength(rawB, 'utf8')
    })
    expect(JSON.stringify(scan.scanMetrics)).not.toContain('private-session')
    expect(JSON.stringify(scan.scanMetrics)).not.toContain('project-a')
  })

  it('quarantines a Session whose normalized id does not match its file name', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    const mismatchedPath = join(projectDir, 'foo.json')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      mismatchedPath,
      JSON.stringify({ version: 2, session: createSession({ id: 'bar' }) }),
      'utf8'
    )

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(true)
    expect(scan.warnings).toEqual([
      {
        kind: 'corrupt',
        projectId: 'project-a',
        fileName: 'foo.json',
        recovered: true
      }
    ])
    await expect(readFile(mismatchedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(projectDir)).resolves.toEqual([
      expect.stringMatching(/^foo\.json\.invalid-/)
    ])
  })

  it('reports a mismatched Session id as corrupt without moving it in read-only mode', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    const mismatchedPath = join(projectDir, 'foo.json')
    const mismatchedJson = JSON.stringify({
      version: 2,
      session: createSession({ id: 'bar' })
    })
    await mkdir(projectDir, { recursive: true })
    await writeFile(mismatchedPath, mismatchedJson, 'utf8')

    const scan = await repository.loadAllWithDiagnostics({ mode: 'read-only' })

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual([
      {
        kind: 'corrupt',
        projectId: 'project-a',
        fileName: 'foo.json',
        recovered: false
      }
    ])
    await expect(
      repository.loadProjectWithDiagnostics('project-a', { mode: 'read-only' })
    ).resolves.toEqual({ sessions: [], isComplete: false })
    await expect(
      repository.loadSessionWithDiagnostics('project-a', 'foo', { mode: 'read-only' })
    ).resolves.toEqual({ status: 'unreadable' })
    await expect(readFile(mismatchedPath, 'utf8')).resolves.toBe(mismatchedJson)
    await expect(readdir(projectDir)).resolves.toEqual(['foo.json'])
  })

  it('leaves an unsupported future Session file in place and marks the scan incomplete', async () => {
    const root = await createStorageRoot()
    const projectDir = join(root, 'sessions', 'project-a')
    const futurePath = join(projectDir, 'future.json')
    const futureJson = JSON.stringify({
      version: 3,
      payload: { id: 'future', futureAuthority: { revision: 1 } }
    })
    const renameFile = vi.fn(rename)
    const repository = new SessionRepository(root, { renameFile })
    await mkdir(projectDir, { recursive: true })
    await writeFile(futurePath, futureJson, 'utf8')

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual([
      {
        kind: 'unsupported-version',
        projectId: 'project-a',
        fileName: 'future.json',
        recovered: false
      }
    ])
    await expect(repository.loadSessionWithDiagnostics('project-a', 'future')).resolves.toEqual({
      status: 'unreadable'
    })
    await expect(readFile(futurePath, 'utf8')).resolves.toBe(futureJson)
    await expect(readdir(projectDir)).resolves.toEqual(['future.json'])
    expect(renameFile).not.toHaveBeenCalled()
  })

  it('does not replace a newer unsupported Session temp with an older compatible temp', async () => {
    const root = await createStorageRoot()
    const projectDir = join(root, 'sessions', 'project-a')
    const primaryPath = join(projectDir, 'session-1.json')
    const compatibleTempPath = `${primaryPath}.1700000000000-1.tmp`
    const unsupportedTempPath = `${primaryPath}.1700000001000-2.tmp`
    const renameFile = vi.fn(rename)
    const repository = new SessionRepository(root, { renameFile })
    await repository.saveSession(createSession({ title: 'Older compatible authority' }))
    await rename(primaryPath, compatibleTempPath)
    const unsupportedJson = JSON.stringify({
      version: 3,
      payload: { id: 'session-1', futureAuthority: { revision: 2 } }
    })
    await writeFile(unsupportedTempPath, unsupportedJson, 'utf8')
    const now = new Date()
    await utimes(
      compatibleTempPath,
      new Date(now.getTime() - 2_000),
      new Date(now.getTime() - 2_000)
    )
    await utimes(
      unsupportedTempPath,
      new Date(now.getTime() - 1_000),
      new Date(now.getTime() - 1_000)
    )
    renameFile.mockClear()

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
    await expect(readFile(unsupportedTempPath, 'utf8')).resolves.toBe(unsupportedJson)
    await expect(readdir(projectDir)).resolves.toEqual([
      'session-1.json.1700000000000-1.tmp',
      'session-1.json.1700000001000-2.tmp'
    ])
    expect(renameFile).not.toHaveBeenCalled()
  })

  it('does not return a differently identified Session from a direct load', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'foo.json'),
      JSON.stringify({ version: 2, session: createSession({ id: 'bar' }) }),
      'utf8'
    )

    await expect(repository.loadSession('project-a', 'foo')).resolves.toBeUndefined()
    await expect(readdir(projectDir)).resolves.toEqual([
      expect.stringMatching(/^foo\.json\.invalid-/)
    ])
  })

  it('loads a Session when its normalized id exactly matches its file name', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'foo.json'),
      JSON.stringify({ version: 2, session: createSession({ id: 'foo' }) }),
      'utf8'
    )

    await expect(repository.loadSession('project-a', 'foo')).resolves.toMatchObject({
      id: 'foo',
      projectId: 'project-a'
    })
  })

  it('applies file-name identity validation to bare legacy Session JSON', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'foo.json'),
      JSON.stringify(createSession({ id: 'bar' })),
      'utf8'
    )

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.warnings).toEqual([
      expect.objectContaining({ kind: 'corrupt', fileName: 'foo.json', recovered: true })
    ])
    await expect(readdir(projectDir)).resolves.toEqual([
      expect.stringMatching(/^foo\.json\.invalid-/)
    ])
  })

  it('fails closed when a mismatched Session cannot be quarantined', async () => {
    const root = await createStorageRoot()
    const projectDir = join(root, 'sessions', 'project-a')
    const mismatchedPath = join(projectDir, 'foo.json')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      mismatchedPath,
      JSON.stringify({ version: 2, session: createSession({ id: 'bar' }) }),
      'utf8'
    )
    const renameFile = vi.fn(async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const repository = new SessionRepository(root, { renameFile })

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual([
      {
        kind: 'corrupt',
        projectId: 'project-a',
        fileName: 'foo.json',
        recovered: false
      }
    ])
    await expect(readFile(mismatchedPath, 'utf8')).resolves.toContain('"id":"bar"')
    expect(renameFile).toHaveBeenCalledOnce()
  })

  it('can save the canonical embedded id after quarantining a mismatched file', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'foo.json'),
      JSON.stringify({ version: 2, session: createSession({ id: 'bar' }) }),
      'utf8'
    )

    await repository.loadAllWithDiagnostics()
    await repository.saveSession(createSession({ id: 'bar' }))

    await expect(repository.loadSession('project-a', 'bar')).resolves.toMatchObject({ id: 'bar' })
    expect(await readdir(projectDir)).toEqual(
      expect.arrayContaining(['bar.json', expect.stringMatching(/^foo\.json\.invalid-/)])
    )
  })

  it('does not let a mismatched embedded id create a false cross-Project duplicate', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectADir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectADir, { recursive: true })
    await writeFile(
      join(projectADir, 'foo.json'),
      JSON.stringify({ version: 2, session: createSession({ id: 'bar' }) }),
      'utf8'
    )
    await repository.saveSession(createSession({ id: 'bar', projectId: 'project-b' }))

    const scan = await repository.loadAllWithDiagnostics({ mode: 'read-only' })

    expect(scan.result.sessions).toEqual([
      expect.objectContaining({ id: 'bar', projectId: 'project-b' })
    ])
    expect(scan.warnings).toEqual([
      {
        kind: 'corrupt',
        projectId: 'project-a',
        fileName: 'foo.json',
        recovered: false
      }
    ])
  })

  it('reports corrupt authority without moving files during a read-only scan', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const sessionsDir = join(storageRoot!, 'sessions')
    const projectDir = join(sessionsDir, 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'broken.json'), '{broken session', 'utf8')
    await writeFile(join(sessionsDir, 'manifest.json'), '{broken manifest', 'utf8')

    const scan = await repository.loadAllWithDiagnostics({ mode: 'read-only' })

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual([
      {
        kind: 'corrupt',
        projectId: 'project-a',
        fileName: 'broken.json',
        recovered: false
      },
      {
        kind: 'manifest-corrupt',
        fileName: 'manifest.json',
        recovered: false
      }
    ])
    await expect(readFile(join(projectDir, 'broken.json'), 'utf8')).resolves.toBe('{broken session')
    await expect(readFile(join(sessionsDir, 'manifest.json'), 'utf8')).resolves.toBe(
      '{broken manifest'
    )
    expect(await readdir(projectDir)).toEqual(['broken.json'])
    expect((await readdir(sessionsDir)).sort()).toEqual(['manifest.json', 'project-a'])
  })

  it('leaves structurally corrupt Session JSON in place during a read-only scan', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    const damagedPath = join(projectDir, 'damaged.json')
    const damagedJson = JSON.stringify({
      version: 2,
      session: { id: 'damaged', messages: 'not-an-array' }
    })
    await mkdir(projectDir, { recursive: true })
    await writeFile(damagedPath, damagedJson, 'utf8')

    const scan = await repository.loadAllWithDiagnostics({ mode: 'read-only' })

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual([
      {
        kind: 'corrupt',
        projectId: 'project-a',
        fileName: 'damaged.json',
        recovered: false
      }
    ])
    await expect(readFile(damagedPath, 'utf8')).resolves.toBe(damagedJson)
    await expect(readdir(projectDir)).resolves.toEqual(['damaged.json'])
  })

  it('keeps direct Project and Session diagnostics strictly read-only', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    const damagedPath = join(projectDir, 'damaged.json')
    const damagedJson = JSON.stringify({
      version: 2,
      session: { id: 'damaged', messages: 'not-an-array' }
    })
    await mkdir(projectDir, { recursive: true })
    await writeFile(damagedPath, damagedJson, 'utf8')

    await expect(
      repository.loadProjectWithDiagnostics('project-a', { mode: 'read-only' })
    ).resolves.toEqual({ sessions: [], isComplete: false })
    await expect(
      repository.loadSessionWithDiagnostics('project-a', 'damaged', { mode: 'read-only' })
    ).resolves.toEqual({ status: 'unreadable' })

    await expect(readFile(damagedPath, 'utf8')).resolves.toBe(damagedJson)
    await expect(readdir(projectDir)).resolves.toEqual(['damaged.json'])
  })

  it('quarantines a structurally corrupt Session instead of normalizing it to empty', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'damaged.json'),
      JSON.stringify({ version: 2, session: { id: 'damaged', messages: 'not-an-array' } }),
      'utf8'
    )

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(true)
    expect(scan.warnings).toEqual([
      {
        kind: 'corrupt',
        projectId: 'project-a',
        fileName: 'damaged.json',
        recovered: true
      }
    ])
    await expect(readdir(projectDir)).resolves.toContainEqual(
      expect.stringMatching(/^damaged\.json\.invalid-/)
    )
  })

  it('uses a valid conversation graph when the compatibility message list is malformed', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const session = createSession()
    await repository.saveSession(session)
    const filePath = join(storageRoot!, 'sessions', session.projectId, `${session.id}.json`)
    const stored = JSON.parse(await readFile(filePath, 'utf8')) as {
      session: { messages: unknown }
    }
    stored.session.messages = 'damaged compatibility projection'
    await writeFile(filePath, JSON.stringify(stored), 'utf8')

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([
      expect.objectContaining({
        id: session.id,
        messages: [expect.objectContaining({ id: 'message-1', content: 'Summarize this file' })]
      })
    ])
    expect(scan.warnings).toEqual([])
  })

  it('keeps a terminal Project scan incomplete while a quarantined Session preserves authority', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'broken.json'), '{broken json', 'utf8')

    const first = await repository.loadProjectWithDiagnostics('project-a')
    const second = await repository.loadProjectWithDiagnostics('project-a')

    expect(first).toEqual({ sessions: [], isComplete: false })
    expect(second).toEqual({ sessions: [], isComplete: false })
    expect(await readdir(projectDir)).toContainEqual(
      expect.stringMatching(/^broken\.json\.invalid-/)
    )
  })

  it('keeps a quarantined Session unreadable on later terminal lookups', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const projectDir = join(storageRoot!, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'broken.json'), '{broken json', 'utf8')

    await expect(repository.loadSessionWithDiagnostics('project-a', 'broken')).resolves.toEqual({
      status: 'unreadable'
    })
    await expect(repository.loadSessionWithDiagnostics('project-a', 'broken')).resolves.toEqual({
      status: 'unreadable'
    })
  })

  it('lets a valid current Session supersede its retained older quarantine', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    const session = createSession()
    await repository.saveSession(session)
    const projectDir = join(storageRoot!, 'sessions', session.projectId)
    const quarantineName = `${session.id}.json.invalid-1710000000000-1`
    await writeFile(join(projectDir, quarantineName), '{older malformed authority', 'utf8')

    await expect(repository.loadSession(session.projectId, session.id)).resolves.toMatchObject({
      id: session.id
    })
    await expect(
      repository.loadSessionWithDiagnostics(session.projectId, session.id)
    ).resolves.toEqual({ status: 'found', session: expect.objectContaining({ id: session.id }) })
    await expect(repository.loadProjectWithDiagnostics(session.projectId)).resolves.toEqual({
      sessions: [expect.objectContaining({ id: session.id })],
      isComplete: true
    })
    await expect(readdir(projectDir)).resolves.toContain(quarantineName)
  })

  it('keeps the scan incomplete without quarantining a session file that cannot be read', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    await new SessionRepository(root).saveSession(session)
    const readSessionFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    const repository = new SessionRepository(root, { readSessionFile })

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual([
      {
        kind: 'unreadable',
        projectId: session.projectId,
        fileName: `${session.id}.json`,
        recovered: false
      }
    ])
    await expect(
      readFile(join(root, 'sessions', session.projectId, `${session.id}.json`), 'utf8')
    ).resolves.toContain(session.id)
    expect(readSessionFile).toHaveBeenCalledOnce()
  })

  it('rejects an oversized Session before reading it into memory', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    await new SessionRepository(root).saveSession(session)
    const filePath = join(root, 'sessions', session.projectId, `${session.id}.json`)
    await truncate(filePath, MAX_PERSISTED_SESSION_BYTES + 1)
    const readSessionFile = vi.fn(async () => JSON.stringify({ version: 2, session }))
    const repository = new SessionRepository(root, { readSessionFile })

    await expect(
      repository.loadSessionWithDiagnostics(session.projectId, session.id, { mode: 'read-only' })
    ).resolves.toEqual({ status: 'unreadable' })
    await expect(repository.loadAllWithDiagnostics({ mode: 'read-only' })).resolves.toMatchObject({
      isComplete: false,
      warnings: [
        {
          kind: 'too-large',
          projectId: session.projectId,
          fileName: `${session.id}.json`,
          recovered: false
        }
      ]
    })
    expect(readSessionFile).not.toHaveBeenCalled()
    await expect(lstat(filePath)).resolves.toMatchObject({ size: MAX_PERSISTED_SESSION_BYTES + 1 })
  })

  it('classifies an oversized recovery temp when no primary Session exists', async () => {
    const root = await createStorageRoot()
    const projectDir = join(root, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    const maxSessionBytes = 4096
    const temporaryPath = join(projectDir, 'session-1.json.1700000000000-1.tmp')
    await writeFile(temporaryPath, '', 'utf8')
    await truncate(temporaryPath, maxSessionBytes + 1)
    const repository = new SessionRepository(root, { maxSessionBytes })

    await expect(repository.loadAllWithDiagnostics({ mode: 'read-only' })).resolves.toMatchObject({
      isComplete: false,
      warnings: [
        {
          kind: 'too-large',
          projectId: 'project-a',
          fileName: 'session-1.json',
          recovered: false
        }
      ]
    })
    await expect(lstat(temporaryPath)).resolves.toMatchObject({ size: maxSessionBytes + 1 })
  })

  it('rejects an oversized Session before publishing another durable file', async () => {
    const root = await createStorageRoot()
    const repository = new SessionRepository(root, { maxSessionBytes: 512 })

    await expect(repository.saveSession(createSession())).rejects.toMatchObject({
      code: SESSION_SIZE_LIMIT_ERROR_CODE
    })
    await expect(
      readFile(join(root, 'sessions', 'project-a', 'session-1.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an oversized existing Session before migration backup reads', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    await new SessionRepository(root).saveSession(session)
    const filePath = join(root, 'sessions', session.projectId, `${session.id}.json`)
    const maxSessionBytes = 4096
    await truncate(filePath, maxSessionBytes + 1)
    const readSessionFile = vi
      .fn()
      .mockRejectedValue(new Error('must not read oversized authority'))
    const repository = new SessionRepository(root, { maxSessionBytes, readSessionFile })

    await expect(
      repository.saveSession({
        ...session,
        runtimeContext: {
          version: 1,
          revision: 1,
          delegatedWork: {
            records: [
              {
                agentFrameId: 'child-frame',
                attempts: [
                  {
                    id: 'attempt-1',
                    initiatingTurnMessageId: 'message-1',
                    status: 'cancelled',
                    resolvedAgent: { kind: 'main' },
                    runtimeSegmentIds: [],
                    startedAt: 1710000000001,
                    endedAt: 1710000000002,
                    cancellationReason: 'main_agent_stop'
                  }
                ]
              }
            ]
          }
        }
      })
    ).rejects.toMatchObject({ code: SESSION_SIZE_LIMIT_ERROR_CODE })
    expect(readSessionFile).not.toHaveBeenCalled()
    await expect(lstat(`${filePath}.pre-s2-backup`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports oversized existing authority before revision comparison', async () => {
    const root = await createStorageRoot()
    const session = await new SessionRepository(root).saveSession(createSession())
    const filePath = join(root, 'sessions', session.projectId, `${session.id}.json`)
    const maxSessionBytes = 4096
    await truncate(filePath, maxSessionBytes + 1)
    const repository = new SessionRepository(root, { maxSessionBytes })

    await expect(repository.saveSession(session, session.revision)).rejects.toMatchObject({
      code: SESSION_SIZE_LIMIT_ERROR_CODE
    })
    await expect(lstat(filePath)).resolves.toMatchObject({ size: maxSessionBytes + 1 })
  })

  it('keeps migration backup reads bounded after existing-authority admission', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    await new SessionRepository(root).saveSession(session)
    const filePath = join(root, 'sessions', session.projectId, `${session.id}.json`)
    const maxSessionBytes = 4096
    const readSessionFile = vi.fn().mockRejectedValue(new Error('unbounded read must not run'))
    const readSessionFileWithinLimit = vi
      .fn()
      .mockRejectedValue(new DurableJsonReadLimitError(`${session.id}.json`, maxSessionBytes))
    const repository = new SessionRepository(root, {
      maxSessionBytes,
      readSessionFile,
      readSessionFileWithinLimit
    })

    await expect(
      repository.saveSession({
        ...session,
        runtimeContext: {
          version: 1,
          revision: 1,
          delegatedWork: {
            records: [
              {
                agentFrameId: 'child-frame',
                attempts: [
                  {
                    id: 'attempt-1',
                    initiatingTurnMessageId: 'message-1',
                    status: 'cancelled',
                    resolvedAgent: { kind: 'main' },
                    runtimeSegmentIds: [],
                    startedAt: 1710000000001,
                    endedAt: 1710000000002,
                    cancellationReason: 'main_agent_stop'
                  }
                ]
              }
            ]
          }
        }
      })
    ).rejects.toMatchObject({ code: SESSION_SIZE_LIMIT_ERROR_CODE })
    expect(readSessionFile).not.toHaveBeenCalled()
    expect(readSessionFileWithinLimit).toHaveBeenCalledWith(filePath, maxSessionBytes)
    await expect(lstat(`${filePath}.pre-s2-backup`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the scan incomplete when a listed Session disappears before it can be read', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    await new SessionRepository(root).saveSession(session)
    const readSessionFile = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('file disappeared during scan'), { code: 'ENOENT' })
      )
    const repository = new SessionRepository(root, { readSessionFile })

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual([
      {
        kind: 'unreadable',
        projectId: session.projectId,
        fileName: `${session.id}.json`,
        recovered: false
      }
    ])
  })

  it('keeps the scan incomplete when an enumerated Project directory disappears', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    await new SessionRepository(root).saveSession(session)
    const sessionsDir = join(root, 'sessions')
    const projectDir = join(sessionsDir, session.projectId)
    const readDirectoryEntries = vi.fn(async (path: string) => {
      const entries = await readdir(path, { withFileTypes: true })
      if (path === sessionsDir) await rm(projectDir, { recursive: true, force: true })
      return entries
    })
    const repository = new SessionRepository(root, { readDirectoryEntries })

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
    expect(readDirectoryEntries).toHaveBeenCalledWith(projectDir)
  })

  it('rejects saving through a symbolic link at the active sessions root', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    await symlink(
      outside,
      join(root, 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const repository = new SessionRepository(root)

    const saveRejected = await repository.saveSession(createSession()).then(
      () => false,
      () => true
    )
    const escaped = await readFile(join(outside, 'project-a', 'session-1.json'), 'utf8').then(
      () => true,
      () => false
    )

    expect({ saveRejected, escaped }).toEqual({ saveRejected: true, escaped: false })
  })

  it('rejects saving through a symbolic link at an active Project directory', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    await mkdir(join(root, 'sessions'), { recursive: true })
    await symlink(
      outside,
      join(root, 'sessions', 'project-a'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const repository = new SessionRepository(root)

    const saveRejected = await repository.saveSession(createSession()).then(
      () => false,
      () => true
    )
    const escaped = await readFile(join(outside, 'session-1.json'), 'utf8').then(
      () => true,
      () => false
    )

    expect({ saveRejected, escaped }).toEqual({ saveRejected: true, escaped: false })
  })

  it('rejects saving committed Project authority through a linked deletion root', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    await mkdir(join(outside, 'project-a'), { recursive: true })
    await symlink(
      outside,
      join(root, 'deleted-sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const repository = new SessionRepository(root)

    const saveRejected = await repository.saveCommittedProjectSession(createSession()).then(
      () => false,
      () => true
    )
    const escaped = await readFile(join(outside, 'project-a', 'session-1.json'), 'utf8').then(
      () => true,
      () => false
    )

    expect({ saveRejected, escaped }).toEqual({ saveRejected: true, escaped: false })
  })

  it('marks committed Project authority incomplete through a linked deletion root', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    await mkdir(join(outside, 'project-a'), { recursive: true })
    await writeFile(
      join(outside, 'project-a', 'session-1.json'),
      JSON.stringify({ version: 2, session: createSession() }),
      'utf8'
    )
    await symlink(
      outside,
      join(root, 'deleted-sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const loaded = await new SessionRepository(root).loadCommittedProjectWithDiagnostics(
      'project-a'
    )

    expect(loaded).toEqual({ sessions: [], isComplete: false })
  })

  it('rejects moving live Project authority through a linked deletion root', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    const session = createSession()
    const repository = new SessionRepository(root)
    await repository.saveSession(session)
    await symlink(
      outside,
      join(root, 'deleted-sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const deletionRejected = await repository.deleteProjectSessions(session.projectId).then(
      () => false,
      () => true
    )
    const escaped = await readFile(
      join(outside, session.projectId, `${session.id}.json`),
      'utf8'
    ).then(
      () => true,
      () => false
    )
    const liveRemains = await readFile(
      join(root, 'sessions', session.projectId, `${session.id}.json`),
      'utf8'
    ).then(
      () => true,
      () => false
    )

    expect({ deletionRejected, escaped, liveRemains }).toEqual({
      deletionRejected: true,
      escaped: false,
      liveRemains: true
    })
  })

  it('rejects completing Project deletion through a linked deletion root', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    const externalProject = join(outside, 'project-a')
    const externalAuthority = join(externalProject, 'keep.json')
    await mkdir(externalProject, { recursive: true })
    await writeFile(externalAuthority, 'external authority', 'utf8')
    await symlink(
      outside,
      join(root, 'deleted-sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const repository = new SessionRepository(root)

    const completionRejected = await repository.completeProjectSessionDeletion('project-a').then(
      () => false,
      () => true
    )
    const externalRemains = await readFile(externalAuthority, 'utf8').then(
      () => true,
      () => false
    )

    expect({ completionRejected, externalRemains }).toEqual({
      completionRejected: true,
      externalRemains: true
    })
  })

  it('rejects classifying Project deletion authority through a linked deletion root', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    await mkdir(join(outside, 'project-a'), { recursive: true })
    await symlink(
      outside,
      join(root, 'deleted-sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      new SessionRepository(root).getProjectSessionDeletionState('project-a')
    ).rejects.toThrow(/Deleted Session root/i)
  })

  it('rejects listing Project deletion authority through a linked deletion root', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    await symlink(
      outside,
      join(root, 'deleted-sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(new SessionRepository(root).listLegacyProjectSessionTombstones()).rejects.toThrow(
      /Deleted Session root/i
    )
  })

  it('marks the active Session scan incomplete for a symbolic-link Project entry', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    await mkdir(join(root, 'sessions'), { recursive: true })
    await writeFile(
      join(outside, 'session-1.json'),
      JSON.stringify({ version: 2, session: createSession() }),
      'utf8'
    )
    await symlink(
      outside,
      join(root, 'sessions', 'project-a'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const scan = await new SessionRepository(root).loadAllWithDiagnostics({ mode: 'read-only' })

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
  })

  it('marks the active Session scan incomplete for a symbolic-link sessions root', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    await mkdir(join(outside, 'project-a'), { recursive: true })
    await writeFile(
      join(outside, 'project-a', 'session-1.json'),
      JSON.stringify({ version: 2, session: createSession() }),
      'utf8'
    )
    await symlink(
      outside,
      join(root, 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const scan = await new SessionRepository(root).loadAllWithDiagnostics({ mode: 'read-only' })

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
  })

  it('marks the active Session scan incomplete for a symbolic-link JSON entry', async () => {
    const root = await createStorageRoot()
    const outside = await createExternalRoot()
    const projectDir = join(root, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await symlink(
      outside,
      join(projectDir, 'session-1.json'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const scan = await new SessionRepository(root).loadAllWithDiagnostics({ mode: 'read-only' })

    expect(scan.result.sessions).toEqual([])
    expect(scan.isComplete).toBe(false)
  })

  it('distinguishes an unreadable Session from an absent Session for terminal mutations', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    await new SessionRepository(root).saveSession(session)
    const repository = new SessionRepository(root, {
      readSessionFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    })

    await expect(
      repository.loadSessionWithDiagnostics(session.projectId, session.id)
    ).resolves.toEqual({ status: 'unreadable' })
  })

  it('keeps terminal diagnostics fail-closed when the Project path is not readable as a directory', async () => {
    const root = await createStorageRoot()
    await mkdir(join(root, 'sessions'), { recursive: true })
    await writeFile(join(root, 'sessions', 'project-a'), 'not a directory', 'utf8')
    const repository = new SessionRepository(root)

    await expect(repository.loadProjectWithDiagnostics('project-a')).resolves.toEqual({
      sessions: [],
      isComplete: false
    })
    await expect(repository.loadSessionWithDiagnostics('project-a', 'session-1')).resolves.toEqual({
      status: 'unreadable'
    })
  })

  it('treats a directly loaded absent Project as an authoritative empty Project', async () => {
    const repository = new SessionRepository(await createStorageRoot())

    await expect(repository.loadProjectWithDiagnostics('missing-project')).resolves.toEqual({
      sessions: [],
      isComplete: true
    })
  })

  it('scans one Project completely without reading an unrelated unreadable Project', async () => {
    const root = await createStorageRoot()
    const writer = new SessionRepository(root)
    const projectASession = createSession({ id: 'session-a', projectId: 'project-a' })
    const projectBSession = createSession({ id: 'session-b', projectId: 'project-b' })
    await writer.saveSession(projectASession)
    await writer.saveSession(projectBSession)
    const readSessionFile = vi.fn(async (filePath: string) => {
      if (filePath.includes(`${join('sessions', 'project-b')}`)) {
        throw Object.assign(new Error('unrelated project unavailable'), { code: 'EACCES' })
      }
      return readFile(filePath, 'utf8')
    })
    const repository = new SessionRepository(root, { readSessionFile })

    await expect(repository.loadProjectWithDiagnostics('project-a')).resolves.toEqual({
      sessions: [expect.objectContaining({ id: 'session-a', projectId: 'project-a' })],
      isComplete: true
    })
    expect(readSessionFile).not.toHaveBeenCalledWith(
      expect.stringContaining(join('sessions', 'project-b'))
    )
    await expect(repository.loadAllWithDiagnostics()).resolves.toMatchObject({
      isComplete: false
    })
  })

  it('keeps default dependencies when optional overrides are explicitly undefined', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    await new SessionRepository(root).saveSession(session)
    const repository = new SessionRepository(root, {
      remove: undefined,
      readSessionFile: undefined
    })

    await expect(repository.loadAll()).resolves.toMatchObject({
      sessions: [{ id: session.id, projectId: session.projectId }]
    })
  })

  it('restores permission waits without interrupting the active turn', async () => {
    const repository = new SessionRepository(await createStorageRoot())

    // saveSession writes verbatim, so this simulates an app that closed after the main process made
    // the permission request durable but before the user responded.
    await repository.saveSession(
      createSession({
        status: 'waiting-permission',
        activeRun: { promptMessageId: 'message-1', startedAt: 1710000000200 },
        activities: [createPendingMcpToolActivity()],
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request: {
              requestId: 'permission-1',
              sessionId: 'session-1',
              toolCallId: 'tool-1',
              title: 'Run npm test',
              providerToolName: 'notebook_execute',
              isMcp: true,
              rawInput: { command: 'npm test' },
              options: [
                {
                  optionId: 'allow-once',
                  name: 'Allow once',
                  kind: 'allow_once',
                  scope: 'once'
                },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
              ]
            },
            originatingPromptMessageId: 'message-1',
            fingerprint: 'a'.repeat(64),
            createdAt: 1710000000200
          }
        }
      })
    )

    const { sessions } = await repository.loadAll()

    expect(sessions[0]).toMatchObject({
      status: 'waiting-permission',
      runtimeContext: {
        permission: {
          request: { requestId: 'permission-1' },
          originatingPromptMessageId: 'message-1'
        }
      }
    })
    expect(sessions[0].activeRun).toBeUndefined()
    expect(sessions[0].resumeRecovery).toBeUndefined()
    expect(sessions[0].error).toBeUndefined()
    expect(sessions[0].messages[0].interrupted).toBeUndefined()
  })

  it('fails a legacy permission wait closed when no durable request authority exists', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    await repository.saveSession(
      createSession({
        status: 'waiting-permission',
        activeRun: { promptMessageId: 'message-1', startedAt: 1710000000200 }
      })
    )

    const { sessions } = await repository.loadAll()

    expect(sessions[0]).toMatchObject({
      status: 'error',
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: 'message-1'
      }
    })
    expect(sessions[0].messages[0].interrupted).toBe(true)
  })

  it('rearms a prompt-bound permission continuation as actionable after restart', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    await repository.saveSession(
      createSession({
        status: 'running',
        activeRun: { promptMessageId: 'message-1', startedAt: 1710000000200 },
        activities: [createPendingMcpToolActivity()],
        runtimeContext: {
          version: 1,
          revision: 2,
          permission: {
            state: 'continuing',
            request: {
              requestId: 'permission-1',
              sessionId: 'session-1',
              toolCallId: 'tool-1',
              title: 'Run npm test',
              isMcp: true,
              options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
            },
            originatingPromptMessageId: 'message-1',
            fingerprint: 'a'.repeat(64),
            createdAt: 1710000000200
          }
        }
      })
    )

    const { sessions } = await repository.loadAll()

    expect(sessions[0]).toMatchObject({
      status: 'waiting-permission',
      runtimeContext: {
        version: 1,
        revision: 2,
        permission: {
          state: 'pending',
          originatingPromptMessageId: 'message-1'
        }
      }
    })
    expect(sessions[0].activeRun).toBeUndefined()
    expect(sessions[0].resumeRecovery).toBeUndefined()
    expect(sessions[0].error).toBeUndefined()
    expect(sessions[0].messages[0].interrupted).toBeUndefined()
  })

  it('fails a permission wait closed when its persisted fingerprint is invalid', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    await repository.saveSession(
      createSession({
        status: 'waiting-permission',
        activeRun: { promptMessageId: 'message-1', startedAt: 1710000000200 },
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request: {
              requestId: 'permission-1',
              sessionId: 'session-1',
              toolCallId: 'tool-1',
              title: 'Run npm test',
              options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
            },
            originatingPromptMessageId: 'message-1',
            fingerprint: 'not-a-valid-fingerprint',
            createdAt: 1710000000200
          }
        }
      })
    )

    const { sessions } = await repository.loadAll()

    expect(sessions[0].status).toBe('error')
    expect(sessions[0].runtimeContext).toBeUndefined()
    expect(sessions[0].messages[0].interrupted).toBe(true)
  })

  it('deletes a single session file and a whole project directory', async () => {
    const repository = new SessionRepository(await createStorageRoot())

    await repository.saveSession(createSession({ id: 'session-1', projectId: 'project-a' }))
    await repository.saveSession(createSession({ id: 'session-2', projectId: 'project-a' }))
    await repository.saveSession(createSession({ id: 'session-3', projectId: 'project-b' }))

    const deletedPrimary = join(storageRoot!, 'sessions', 'project-a', 'session-1.json')
    await writeFile(`${deletedPrimary}.pre-s2-backup`, 'pre-S2 authority', 'utf8')
    await writeFile(`${deletedPrimary}.pre-subagent-model-backup`, 'pre-model authority', 'utf8')

    await repository.deleteSession('project-a', 'session-1')
    await expect(readFile(deletedPrimary, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${deletedPrimary}.pre-s2-backup`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      readFile(`${deletedPrimary}.pre-subagent-model-backup`, 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await repository.loadAll()).sessions.map((session) => session.id).sort()).toEqual([
      'session-2',
      'session-3'
    ])

    await expect(repository.deleteProjectSessions('project-a')).resolves.toBeUndefined()
    expect((await repository.loadAll()).sessions.map((session) => session.id)).toEqual([
      'session-3'
    ])
  })

  it('drops the saved revision when deleting a Session', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    await expect(repository.saveSession(createSession())).resolves.toMatchObject({ revision: 1 })

    await repository.deleteSession('project-a', 'session-1')

    await expect(repository.saveSession(createSession())).resolves.toMatchObject({ revision: 1 })
  })

  it('keeps valid primary JSON when removing a superseded quarantine fails', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    const quarantinePath = join(
      root,
      'sessions',
      session.projectId,
      `${session.id}.json.invalid-1710000000000-1`
    )
    const removalFailure = new Error('backup is locked')
    const remove = vi.fn(async (path: string, options: { force: boolean; recursive: boolean }) => {
      if (path === quarantinePath) throw removalFailure
      await rm(path, options)
    })
    const repository = new SessionRepository(root, { remove })
    await repository.saveSession(session)
    await writeFile(quarantinePath, '{older malformed authority', 'utf8')

    await expect(repository.deleteSession(session.projectId, session.id)).rejects.toBe(
      removalFailure
    )

    await expect(
      repository.loadSessionWithDiagnostics(session.projectId, session.id)
    ).resolves.toEqual({ status: 'found', session: expect.objectContaining({ id: session.id }) })
    await expect(readFile(quarantinePath, 'utf8')).resolves.toBe('{older malformed authority')
  })

  it.each(['.pre-s2-backup', '.pre-subagent-model-backup'])(
    'keeps primary Session authority when deleting %s fails',
    async (failingSuffix) => {
      const root = await createStorageRoot()
      const session = createSession()
      const primaryPath = join(root, 'sessions', session.projectId, `${session.id}.json`)
      const failingPath = `${primaryPath}${failingSuffix}`
      const removalFailure = new Error(`${failingSuffix} is locked`)
      const remove = vi.fn(
        async (path: string, options: { force: boolean; recursive: boolean }) => {
          if (path === failingPath) throw removalFailure
          await rm(path, options)
        }
      )
      const repository = new SessionRepository(root, { remove })
      await repository.saveSession(session)
      await writeFile(`${primaryPath}.pre-s2-backup`, 'pre-S2 authority', 'utf8')
      await writeFile(`${primaryPath}.pre-subagent-model-backup`, 'pre-model authority', 'utf8')

      await expect(repository.deleteSession(session.projectId, session.id)).rejects.toBe(
        removalFailure
      )

      await expect(readFile(primaryPath, 'utf8')).resolves.toContain('Saved conversation')
      await expect(
        repository.loadSessionWithDiagnostics(session.projectId, session.id)
      ).resolves.toEqual({ status: 'found', session: expect.objectContaining({ id: session.id }) })
    }
  )

  it('does not delete orphan quarantines or current invalid primary authority', async () => {
    const root = await createStorageRoot()
    const projectDir = join(root, 'sessions', 'project-a')
    const orphanPath = join(projectDir, 'orphan.json.invalid-1710000000000-1')
    const invalidPath = join(projectDir, 'invalid.json')
    await mkdir(projectDir, { recursive: true })
    await writeFile(orphanPath, '{orphan authority', 'utf8')
    await writeFile(invalidPath, '{current invalid authority', 'utf8')
    const repository = new SessionRepository(root)

    await expect(repository.deleteSession('project-a', 'orphan')).rejects.toThrow(/unreadable/i)
    await expect(readFile(orphanPath, 'utf8')).resolves.toBe('{orphan authority')

    await expect(repository.deleteSession('project-a', 'invalid')).rejects.toThrow(/unreadable/i)
    const invalidBackup = (await readdir(projectDir)).find((name) =>
      /^invalid\.json\.invalid-\d+-\d+$/u.test(name)
    )
    expect(invalidBackup).toBeDefined()
    await expect(readFile(join(projectDir, invalidBackup!), 'utf8')).resolves.toBe(
      '{current invalid authority'
    )
  })

  it('keeps a marked Project tombstone through loadAll until tail completion', async () => {
    const root = await createStorageRoot()
    const repository = new SessionRepository(root)
    await repository.saveSession(createSession({ id: 'session-1', projectId: 'project-a' }))
    await repository.saveSession(createSession({ id: 'session-2', projectId: 'project-a' }))

    await expect(repository.deleteProjectSessions('project-a')).resolves.toBeUndefined()
    await expect(repository.loadAll()).resolves.toMatchObject({ sessions: [] })
    expect((await readdir(join(root, 'deleted-sessions', 'project-a'))).sort()).toEqual([
      '.project-deletion-committed',
      'session-1.json',
      'session-2.json'
    ])
    await expect(repository.getProjectSessionDeletionState('project-a')).resolves.toBe('prepared')
    await expect(repository.listLegacyProjectSessionTombstones()).resolves.toEqual([])

    await repository.completeProjectSessionDeletion('project-a')

    await expect(repository.getProjectSessionDeletionState('project-a')).resolves.toBe('absent')
  })

  it('commits an empty Project Session phase with a durable marker', async () => {
    const root = await createStorageRoot()
    const repository = new SessionRepository(root)

    await repository.deleteProjectSessions('project-empty')

    await expect(repository.getProjectSessionDeletionState('project-empty')).resolves.toBe(
      'prepared'
    )
    await expect(readdir(join(root, 'deleted-sessions', 'project-empty'))).resolves.toEqual([
      '.project-deletion-committed'
    ])
  })

  it('discovers an unmarked legacy Project tombstone without deleting its authority', async () => {
    const root = await createStorageRoot()
    const legacyTombstone = join(root, 'deleted-sessions', 'project-old')
    await mkdir(legacyTombstone, { recursive: true })
    await writeFile(join(legacyTombstone, 'session.json'), '{}', 'utf8')
    const repository = new SessionRepository(root)

    await expect(repository.getProjectSessionDeletionState('project-old')).resolves.toBe(
      'legacy-committed'
    )
    await repository.loadAll()

    await expect(readdir(legacyTombstone)).resolves.toEqual(['session.json'])
    await expect(repository.listLegacyProjectSessionTombstones()).resolves.toEqual(['project-old'])
    await expect(readdir(legacyTombstone)).resolves.toEqual(['session.json'])
  })

  it('retains a tombstone with a malformed commit marker as unknown authority', async () => {
    const root = await createStorageRoot()
    const tombstone = join(root, 'deleted-sessions', 'project-unknown')
    const marker = join(tombstone, '.project-deletion-committed')
    await mkdir(marker, { recursive: true })
    const repository = new SessionRepository(root)

    await expect(repository.getProjectSessionDeletionState('project-unknown')).rejects.toThrow(
      /marker is invalid/i
    )
    await expect(repository.listLegacyProjectSessionTombstones()).rejects.toThrow(
      /marker is invalid/i
    )
    await repository.loadAll()

    await expect(readdir(tombstone)).resolves.toEqual(['.project-deletion-committed'])
  })

  it('rejects conflicting live authority beside a marked Project tombstone', async () => {
    const root = await createStorageRoot()
    const repository = new SessionRepository(root)
    await repository.saveSession(createSession({ projectId: 'project-conflict' }))
    const tombstone = join(root, 'deleted-sessions', 'project-conflict')
    await mkdir(tombstone, { recursive: true })
    await writeFile(join(tombstone, '.project-deletion-committed'), '', 'utf8')

    await expect(repository.getProjectSessionDeletionState('project-conflict')).rejects.toThrow(
      /conflicting live authority/i
    )
    await expect(repository.listLegacyProjectSessionTombstones()).rejects.toThrow(
      /conflicting live authority/i
    )
  })

  it('rejects conflicting live authority beside an unmarked legacy tombstone', async () => {
    const root = await createStorageRoot()
    const repository = new SessionRepository(root)
    await repository.saveSession(createSession({ projectId: 'project-legacy-conflict' }))
    const tombstone = join(root, 'deleted-sessions', 'project-legacy-conflict')
    await mkdir(tombstone, { recursive: true })
    await writeFile(join(tombstone, 'old-session.json'), '{}', 'utf8')

    await expect(
      repository.getProjectSessionDeletionState('project-legacy-conflict')
    ).rejects.toThrow(/conflicting live authority/i)
  })

  it('round-trips the manifest', async () => {
    const repository = new SessionRepository(await createStorageRoot())

    await repository.saveManifest({ lastSessionId: 'session-1' })

    await expect(repository.loadAll()).resolves.toMatchObject({
      manifest: { version: 1, lastSessionId: 'session-1' }
    })
  })

  it('isolates a corrupt manifest and reports the recovered selection data', async () => {
    const root = await createStorageRoot()
    const repository = new SessionRepository(root)
    await mkdir(join(root, 'sessions'), { recursive: true })
    await writeFile(join(root, 'sessions', 'manifest.json'), '{broken json', 'utf8')

    await expect(repository.loadAllWithDiagnostics()).resolves.toMatchObject({
      result: { sessions: [], manifest: { version: 1 } },
      isComplete: true,
      warnings: [
        {
          kind: 'manifest-corrupt',
          fileName: 'manifest.json',
          recovered: true
        }
      ]
    })
    expect(await readdir(join(root, 'sessions'))).toContainEqual(
      expect.stringMatching(/^manifest\.json\.invalid-/)
    )

    await expect(repository.loadAllWithDiagnostics()).resolves.toMatchObject({
      result: { sessions: [], manifest: { version: 1 } },
      isComplete: true,
      warnings: []
    })
  })

  it('falls back to an empty selection without blocking a complete Session scan', async () => {
    const root = await createStorageRoot()
    const session = createSession()
    await new SessionRepository(root).saveSession(session)
    const readManifestFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    const repository = new SessionRepository(root, { readManifestFile })

    await expect(repository.loadAllWithDiagnostics()).resolves.toMatchObject({
      result: {
        sessions: [expect.objectContaining({ id: session.id })],
        manifest: { version: 1 }
      },
      isComplete: true,
      warnings: [
        {
          kind: 'manifest-unreadable',
          fileName: 'manifest.json',
          recovered: false
        }
      ]
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

  it('accepts unused or same-Project durable Session identity ownership', async () => {
    const repository = new SessionRepository(await createStorageRoot())

    await expect(
      repository.assertSessionIdentityOwnership('unused-session', 'project-a')
    ).resolves.toBeUndefined()
    await repository.saveSession(createSession({ id: 'session-1', projectId: 'project-a' }))
    await expect(
      repository.assertSessionIdentityOwnership('session-1', 'project-a')
    ).resolves.toBeUndefined()
  })

  it('omits every cross-project duplicate Session id without modifying durable files', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    await repository.saveSession(createSession({ id: 'duplicate-session', projectId: 'project-a' }))
    await repository.saveSession(createSession({ id: 'duplicate-session', projectId: 'project-b' }))
    await repository.saveSession(createSession({ id: 'healthy-session', projectId: 'project-c' }))

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions.map((session) => session.id)).toEqual(['healthy-session'])
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual(
      expect.arrayContaining([
        {
          kind: 'unreadable',
          projectId: 'project-a',
          fileName: 'duplicate-session.json',
          recovered: false
        },
        {
          kind: 'unreadable',
          projectId: 'project-b',
          fileName: 'duplicate-session.json',
          recovered: false
        }
      ])
    )
    expect(scan.warnings).toHaveLength(2)
    await expect(
      readFile(join(storageRoot!, 'sessions', 'project-a', 'duplicate-session.json'), 'utf8')
    ).resolves.toContain('duplicate-session')
    await expect(
      readFile(join(storageRoot!, 'sessions', 'project-b', 'duplicate-session.json'), 'utf8')
    ).resolves.toContain('duplicate-session')
    await expect(
      repository.assertSessionIdentityOwnership('duplicate-session', 'project-a')
    ).rejects.toThrow(/Session id.*another Project/)
  })

  it('does not hydrate a valid Session whose id also has an unreadable cross-Project file', async () => {
    const repository = new SessionRepository(await createStorageRoot())
    await repository.saveSession(createSession({ id: 'duplicate-session', projectId: 'project-a' }))
    await repository.saveSession(createSession({ id: 'healthy-session', projectId: 'project-c' }))
    const projectBDir = join(storageRoot!, 'sessions', 'project-b')
    await mkdir(projectBDir, { recursive: true })
    await writeFile(join(projectBDir, 'duplicate-session.json'), '{invalid', 'utf8')

    const scan = await repository.loadAllWithDiagnostics({ mode: 'read-only' })

    expect(scan.result.sessions.map((session) => session.id)).toEqual(['healthy-session'])
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual(
      expect.arrayContaining([
        {
          kind: 'unreadable',
          projectId: 'project-a',
          fileName: 'duplicate-session.json',
          recovered: false
        },
        {
          kind: 'corrupt',
          projectId: 'project-b',
          fileName: 'duplicate-session.json',
          recovered: false
        }
      ])
    )
    await expect(
      repository.assertSessionIdentityOwnership('duplicate-session', 'project-a')
    ).rejects.toThrow(/Session id.*another Project/)
  })

  it('rejects ownership checks when the durable Session catalog is unreadable', async () => {
    const root = await createStorageRoot()
    await mkdir(join(root, 'sessions'), { recursive: true })
    const repository = new SessionRepository(root, {
      readDirectoryEntries: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    })

    await expect(
      repository.assertSessionIdentityOwnership('session-1', 'project-a')
    ).rejects.toThrow(/global identity ownership is unreadable/)
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
