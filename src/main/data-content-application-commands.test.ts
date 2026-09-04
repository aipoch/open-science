import { describe, expect, it, vi } from 'vitest'

import {
  createApplicationCommandRouter,
  type ApplicationCommandRouter,
  type ApplicationInvocation
} from './application-command-router'
import {
  createCallerContext,
  createTaskCallerContext,
  createWebCallerContext,
  type CallerContext
} from './caller-context'
import {
  ArtifactFinalizationProofError,
  ArtifactOwnershipPersistenceRaceError
} from './artifacts/provenance-repository'
import {
  dataContentApplicationCommandGroups,
  dataContentApplicationCommands,
  registerDataContentApplicationCommands,
  type DataContentApplicationCommandDependencies
} from './data-content-application-commands'
import {
  materializeSessionConversationGraph,
  SessionDetailsConflictError,
  SessionRevisionConflictError,
  type PersistedChatSession,
  type SessionDeletionResult
} from '../shared/session-persistence'
import { ApplicationCommandError } from '../shared/application-command-contract'
import { MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID } from '../shared/lifecycle-events'
import { ApplicationEventHub } from './application-events'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters,
  withDataRootWrite
} from './storage/migration-state'

const callerContext = createCallerContext({
  clientId: 'renderer-1',
  lifecycleClientId: 'web:renderer-1',
  leaseId: 'renderer-lease-1',
  surface: 'web',
  location: 'local',
  principalKind: 'human',
  actionOrigin: 'human'
})

const electronCaller = createCallerContext({
  clientId: 'renderer-electron',
  lifecycleClientId: 'electron:renderer-electron',
  leaseId: 'electron-lease-1',
  surface: 'electron',
  location: 'local',
  principalKind: 'human',
  actionOrigin: 'human'
})

const remoteCaller = createCallerContext({
  clientId: 'renderer-remote',
  lifecycleClientId: 'web:renderer-remote',
  leaseId: 'remote-lease-1',
  surface: 'web',
  location: 'remote',
  principalKind: 'human',
  actionOrigin: 'human'
})

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  caller: CallerContext = callerContext
): ApplicationInvocation<Args> => ({
  callerContext: caller,
  callerLease: {
    leaseId: caller.leaseId,
    generation: 7,
    signal: new AbortController().signal,
    isCurrent: () => true
  },
  args
})

const registeredCommands = (): Array<{ name: string }> => {
  const commands: Array<{ name: string }> = []
  for (const group of dataContentApplicationCommandGroups) commands.push(...group.commands)
  return commands
}

// The inferred spy surface is intentionally retained so each assertion keeps its exact Vitest type.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const createDependencies = () => {
  const artifacts = {
    finalizeRunArtifacts: vi.fn(async () => []),
    reconcilePendingArtifacts: vi.fn(async () => []),
    openFile: vi.fn(async () => undefined),
    readPreview: vi.fn(async () => ({ content: '', encoding: 'utf8', size: 0, truncated: false })),
    getLineage: vi.fn(async () => undefined),
    getVersionProvenance: vi.fn(),
    getVersionExecution: vi.fn(),
    getVersionMessages: vi.fn(),
    getVersionReview: vi.fn(),
    getCodeReconstruction: vi.fn(),
    generateCodeReconstruction: vi.fn(),
    resolveVersionDescriptors: vi.fn(async () => [])
  }
  const events = { publish: vi.fn() }
  const managedPreview = {
    acquire: vi.fn(async () => ({
      id: 'resource-1',
      url: 'open-science-preview://resource-1/file',
      size: 10,
      mimeType: 'text/plain',
      version: 1
    })),
    readRange: vi.fn(async () => ({
      begin: 0,
      end: 1,
      total: 1,
      data: new Uint8Array([1])
    })),
    register: vi.fn(),
    release: vi.fn()
  }
  const preview = { load: vi.fn(), save: vi.fn(), delete: vi.fn() }
  const projectFiles = {
    getOverview: vi.fn(),
    listArtifactGroups: vi.fn(),
    listFiles: vi.fn(),
    repairIndex: vi.fn(),
    resolveFile: vi.fn(),
    searchArtifacts: vi.fn()
  }
  const project = {
    id: 'project-1',
    name: 'Project',
    description: '',
    isExample: false,
    createdAt: 1,
    updatedAt: 1
  }
  const projects = {
    create: vi.fn(async () => project),
    delete: vi.fn(async () => ({ status: 'cleanup-pending' as const })),
    get: vi.fn(async () => project),
    list: vi.fn(async () => [project]),
    listDeletionCleanup: vi.fn(async () => []),
    retryDeletionCleanup: vi.fn(async () => undefined),
    updateArchive: vi.fn(async () => project),
    update: vi.fn(async () => project)
  }
  const session = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Session',
    cwd: '/workspace',
    status: 'idle' as const,
    createdAt: 1,
    updatedAt: 1,
    messages: []
  }
  const sessions = {
    editDetails: vi.fn(async () => session),
    filterPdfContextCandidates: vi.fn(async () => ({
      sources: [],
      pendingAttachmentIds: []
    })),
    linkPdfContext: vi.fn(async () => ({ version: 1 as const, revision: 1 })),
    unlinkPdfContext: vi.fn(async () => ({ version: 1 as const, revision: 1 })),
    list: vi.fn(),
    loadAll: vi.fn(),
    loadOne: vi.fn(),
    loadUsage: vi.fn(),
    saveSession: vi.fn(async () => ({ created: true, session })),
    stageTaskCompletion: vi.fn(async () => session),
    settleTaskCompletion: vi.fn(async () => session),
    failTaskRun: vi.fn(async () => session),
    setDelegationPolicy: vi.fn(async () => session),
    updateSessionConfiguration: vi.fn(async () => session),
    deleteSession: vi.fn(async (): Promise<SessionDeletionResult> => ({
      status: 'deleted',
      runtimeDetached: true
    })),
    saveManifest: vi.fn(),
    updateArchive: vi.fn(async () => session)
  }
  const attachment = {
    id: 'upload-1',
    sessionId: 'standalone-uploads',
    name: 'report.txt',
    originalName: 'report.txt',
    path: 'upload-version:version-1',
    size: 10
  }
  const uploads = {
    claimLocalFile: vi.fn(),
    stageLocalPath: vi.fn(async () => attachment),
    beginTransfer: vi.fn(),
    appendTransfer: vi.fn(),
    transferStatus: vi.fn(),
    finishTransfer: vi.fn(),
    abortTransfer: vi.fn(),
    deleteUpload: vi.fn(),
    finalizeSession: vi.fn(async () => []),
    readPreview: vi.fn()
  }
  const electron = {
    exportConversationFromInvokingWindow: vi.fn(async () => ({ saved: false as const })),
    stageLocalFileWithProgress: vi.fn(async () => attachment)
  }
  const withDataRootWrite = vi.fn(async <Result>(operation: () => Promise<Result>) => operation())
  const dependencies = {
    artifacts,
    electron,
    events,
    managedPreview,
    preview,
    projectFiles,
    projects,
    sessions,
    uploads,
    withDataRootWrite
  } as unknown as DataContentApplicationCommandDependencies
  return {
    dependencies,
    artifacts,
    attachment,
    electron,
    events,
    managedPreview,
    preview,
    project,
    projectFiles,
    projects,
    session,
    sessions,
    uploads,
    withDataRootWrite
  }
}

type DataContentCommandKey = keyof typeof dataContentApplicationCommands
const WRAPPED_COMMAND_KEYS = [
  'artifactFinalizeRun',
  'artifactOpenFile',
  'lifecycleClientId',
  'projectCreate',
  'projectDelete',
  'projectUpdate',
  'projectUpdateSessionDefaults',
  'sessionDelete',
  'sessionEditDetails',
  'sessionExportConversation',
  'sessionFilterPdfContextCandidates',
  'sessionLinkPdfContext',
  'sessionList',
  'sessionLoadAll',
  'sessionLoadOne',
  'sessionLoadUsage',
  'sessionSaveManifest',
  'sessionSave',
  'sessionStageTaskCompletion',
  'sessionSettleTaskCompletion',
  'sessionFailTaskRun',
  'sessionSetDelegationPolicy',
  'sessionUpdateConfiguration',
  'sessionUnlinkPdfContext',
  'uploadStageLocalFile',
  'uploadStageLocalPath'
] as const satisfies readonly DataContentCommandKey[]
type DispatchedCommand = {
  invocation: ApplicationInvocation<readonly unknown[]>
  result: Promise<unknown>
}

const dispatchCommand = (
  router: ApplicationCommandRouter,
  key: DataContentCommandKey,
  args: readonly unknown[],
  caller: CallerContext = callerContext
): DispatchedCommand => {
  const commandInvocation = invocation(args, caller)
  const invoke = router.dispatcher.invoke as unknown as (
    command: { name: string },
    currentInvocation: ApplicationInvocation<readonly unknown[]>
  ) => Promise<unknown>
  return {
    invocation: commandInvocation,
    result: invoke(dataContentApplicationCommands[key], commandInvocation)
  }
}

describe('Data and content application commands', () => {
  it('owns exactly the 58 current data and content invoke channels', () => {
    expect(registeredCommands()).toEqual(
      [
        'artifacts:finalize-run',
        'artifacts:generate-code-reconstruction',
        'artifacts:get-code-reconstruction',
        'artifacts:get-lineage',
        'artifacts:get-version-execution',
        'artifacts:get-version-messages',
        'artifacts:get-version-provenance',
        'artifacts:get-version-review',
        'artifacts:open-file',
        'artifacts:read-preview',
        'artifacts:reconcile-pending',
        'artifacts:resolve-version-descriptors',
        'lifecycle:client-id',
        'preview:delete',
        'preview:load',
        'preview:save',
        'preview-resources:acquire',
        'preview-resources:read-range',
        'preview-resources:release',
        'project-files:get-overview',
        'project-files:list-artifact-groups',
        'project-files:list-files',
        'project-files:repair-index',
        'project-files:resolve-file',
        'project-files:search-artifacts',
        'projects:create',
        'projects:update-archive',
        'projects:delete',
        'projects:get',
        'projects:list',
        'projects:list-deletion-cleanup',
        'projects:retry-deletion-cleanup',
        'projects:update',
        'projects:update-session-defaults',
        'sessions:delete-session',
        'sessions:edit-details',
        'sessions:export-conversation',
        'sessions:filter-pdf-context-candidates',
        'sessions:link-pdf-context',
        'sessions:list',
        'sessions:load-all',
        'sessions:load-one',
        'sessions:load-usage',
        'sessions:save-manifest',
        'sessions:update-archive',
        'sessions:unlink-pdf-context',
        'sessions:save-session',
        'sessions:stage-task-completion',
        'sessions:settle-task-completion',
        'sessions:fail-task-run',
        'sessions:set-delegation-policy',
        'sessions:update-configuration',
        'uploads:abort-transfer',
        'uploads:append-transfer',
        'uploads:begin-transfer',
        'uploads:claim-local-file',
        'uploads:delete',
        'uploads:finalize-session',
        'uploads:finish-transfer',
        'uploads:read-preview',
        'uploads:stage-local-file',
        'uploads:stage-local-path',
        'uploads:transfer-status'
      ].map((name) => expect.objectContaining({ name }))
    )
  })

  it('registers the exact inventory and resolves lifecycle identity from caller authority', async () => {
    const router = createApplicationCommandRouter()
    const installation = registerDataContentApplicationCommands(
      router.registrar,
      createDependencies().dependencies
    )

    expect(router.dispatcher.commandNames()).toEqual(
      registeredCommands()
        .map((command) => command.name)
        .sort()
    )
    await expect(
      router.dispatcher.invoke(dataContentApplicationCommands.lifecycleClientId, invocation([]))
    ).resolves.toBe('web:renderer-1')

    installation.uninstall()
    expect(router.dispatcher.commandNames()).toEqual([])
  })

  it('maps every pass-through command to its exact existing owner method', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const request = (key: string): Readonly<{ key: string }> => Object.freeze({ key })
    const cases = [
      {
        key: 'artifactGenerateCodeReconstruction',
        args: [request('generate-code-reconstruction')],
        owner: deps.artifacts.generateCodeReconstruction
      },
      {
        key: 'artifactGetCodeReconstruction',
        args: [request('get-code-reconstruction')],
        owner: deps.artifacts.getCodeReconstruction
      },
      {
        key: 'artifactGetLineage',
        args: [request('lineage')],
        owner: deps.artifacts.getLineage
      },
      {
        key: 'artifactGetVersionExecution',
        args: [request('version-execution')],
        owner: deps.artifacts.getVersionExecution
      },
      {
        key: 'artifactGetVersionMessages',
        args: [request('version-messages')],
        owner: deps.artifacts.getVersionMessages
      },
      {
        key: 'artifactGetVersionProvenance',
        args: [request('version-provenance')],
        owner: deps.artifacts.getVersionProvenance
      },
      {
        key: 'artifactGetVersionReview',
        args: [request('version-review')],
        owner: deps.artifacts.getVersionReview
      },
      {
        key: 'artifactReadPreview',
        args: [request('artifact-preview')],
        owner: deps.artifacts.readPreview
      },
      {
        key: 'artifactReconcilePending',
        args: [request('artifact-reconcile')],
        owner: deps.artifacts.reconcilePendingArtifacts
      },
      {
        key: 'artifactResolveVersionDescriptors',
        args: [request('artifact-version-descriptors')],
        owner: deps.artifacts.resolveVersionDescriptors
      },
      { key: 'previewDelete', args: [request('preview-delete')], owner: deps.preview.delete },
      { key: 'previewLoad', args: [request('preview-load')], owner: deps.preview.load },
      { key: 'previewSave', args: [request('preview-save')], owner: deps.preview.save },
      {
        key: 'previewResourceAcquire',
        args: [request('preview-resource-acquire')],
        owner: deps.managedPreview.acquire,
        passCallerLease: true
      },
      {
        key: 'previewResourceReadRange',
        args: [request('preview-resource-read')],
        owner: deps.managedPreview.readRange,
        passCallerLease: true
      },
      {
        key: 'previewResourceRelease',
        args: [request('preview-resource-release')],
        owner: deps.managedPreview.release,
        passCallerLease: true
      },
      {
        key: 'projectFilesGetOverview',
        args: [request('project-files-overview')],
        owner: deps.projectFiles.getOverview
      },
      {
        key: 'projectFilesListArtifactGroups',
        args: [request('project-files-groups')],
        owner: deps.projectFiles.listArtifactGroups
      },
      {
        key: 'projectFilesListFiles',
        args: [request('project-files-list')],
        owner: deps.projectFiles.listFiles
      },
      {
        key: 'projectFilesRepairIndex',
        args: [request('project-files-repair')],
        owner: deps.projectFiles.repairIndex
      },
      {
        key: 'projectFilesResolveFile',
        args: [request('project-files-resolve')],
        owner: deps.projectFiles.resolveFile
      },
      {
        key: 'projectFilesSearchArtifacts',
        args: [request('project-files-search')],
        owner: deps.projectFiles.searchArtifacts
      },
      { key: 'projectGet', args: ['project-1'], owner: deps.projects.get },
      { key: 'projectList', args: [], owner: deps.projects.list },
      {
        key: 'projectListDeletionCleanup',
        args: [],
        owner: deps.projects.listDeletionCleanup
      },
      {
        key: 'projectRetryDeletionCleanup',
        args: [],
        owner: deps.projects.retryDeletionCleanup
      },
      {
        key: 'projectUpdateArchive',
        args: [{ id: 'project-1', archived: true, expectedArchivedAt: null }],
        owner: deps.projects.updateArchive
      },
      {
        key: 'sessionUpdateArchive',
        args: [
          {
            projectId: 'project-1',
            sessionId: 'session-1',
            archived: true,
            expectedArchivedAt: null
          }
        ],
        owner: deps.sessions.updateArchive
      },
      {
        key: 'uploadAbortTransfer',
        args: [request('upload-abort')],
        owner: deps.uploads.abortTransfer,
        passInvocation: true
      },
      {
        key: 'uploadAppendTransfer',
        args: [request('upload-append')],
        owner: deps.uploads.appendTransfer,
        passInvocation: true
      },
      {
        key: 'uploadBeginTransfer',
        args: [request('upload-begin')],
        owner: deps.uploads.beginTransfer,
        passInvocation: true
      },
      {
        key: 'uploadClaimLocalFile',
        args: [request('upload-claim')],
        owner: deps.uploads.claimLocalFile,
        passInvocation: true
      },
      {
        key: 'uploadDelete',
        args: [request('upload-delete')],
        owner: deps.uploads.deleteUpload,
        passInvocation: true
      },
      {
        key: 'uploadFinalizeSession',
        args: [{ projectId: 'project-1', sessionId: 'session-1', attachments: [] }],
        owner: deps.uploads.finalizeSession,
        passInvocation: true
      },
      {
        key: 'uploadFinishTransfer',
        args: [request('upload-finish')],
        owner: deps.uploads.finishTransfer,
        passInvocation: true
      },
      {
        key: 'uploadReadPreview',
        args: [request('upload-preview')],
        owner: deps.uploads.readPreview,
        passInvocation: true
      },
      {
        key: 'uploadTransferStatus',
        args: [request('upload-status')],
        owner: deps.uploads.transferStatus,
        passInvocation: true
      }
    ] as const

    for (const testCase of cases) {
      const dispatched = dispatchCommand(router, testCase.key, testCase.args)
      await dispatched.result
      const expectedArgs =
        'passInvocation' in testCase
          ? [dispatched.invocation]
          : 'passCallerLease' in testCase
            ? [dispatched.invocation.callerLease, ...testCase.args]
            : testCase.args
      expect(testCase.owner, testCase.key).toHaveBeenCalledWith(...expectedArgs)
    }

    expect(
      [...cases.map(({ key }) => key), ...WRAPPED_COMMAND_KEYS]
        .map((key) => dataContentApplicationCommands[key].name)
        .sort()
    ).toEqual(
      registeredCommands()
        .map(({ name }) => name)
        .sort()
    )
  })

  it.each([
    {
      label: 'malformed attachment',
      request: {
        projectId: 'project-1',
        sessionId: 'session-1',
        attachments: [
          {
            id: 'upload-1',
            sessionId: '.pending',
            name: 'report.txt',
            path: 'upload-version:version-1',
            size: 10
          }
        ]
      }
    },
    {
      label: 'more than ten attachments',
      request: {
        projectId: 'project-1',
        sessionId: 'session-1',
        attachments: Array.from({ length: 11 }, (_, index) => ({
          id: `upload-${index}`,
          sessionId: '.pending',
          name: `report-${index}.txt`,
          originalName: `report-${index}.txt`,
          path: `upload-version:version-${index}`,
          size: 10
        }))
      }
    },
    {
      label: 'duplicate attachment ids',
      request: {
        projectId: 'project-1',
        sessionId: 'session-1',
        attachments: [
          {
            id: 'upload-1',
            sessionId: '.pending',
            name: 'report-1.txt',
            originalName: 'report-1.txt',
            path: 'upload-version:version-1',
            size: 10
          },
          {
            id: 'upload-1',
            sessionId: '.pending',
            name: 'report-2.txt',
            originalName: 'report-2.txt',
            path: 'upload-version:version-2',
            size: 10
          }
        ]
      }
    },
    {
      label: 'duplicate attachment paths',
      request: {
        projectId: 'project-1',
        sessionId: 'session-1',
        attachments: [
          {
            id: 'upload-1',
            sessionId: '.pending',
            name: 'report-1.txt',
            originalName: 'report-1.txt',
            path: 'upload-version:version-1',
            size: 10
          },
          {
            id: 'upload-2',
            sessionId: '.pending',
            name: 'report-2.txt',
            originalName: 'report-2.txt',
            path: 'upload-version:version-1',
            size: 10
          }
        ]
      }
    }
  ])(
    'rejects an invalid finalize upload request ($label) before reaching the owner',
    async ({ request }) => {
      const router = createApplicationCommandRouter()
      const deps = createDependencies()
      registerDataContentApplicationCommands(router.registrar, deps.dependencies)

      const { result: dispatched } = dispatchCommand(
        router,
        'uploadFinalizeSession',
        [request],
        remoteCaller
      )

      await expect(dispatched).rejects.toMatchObject({ code: 'invalid-command-arguments' })
      expect(deps.uploads.finalizeSession).not.toHaveBeenCalled()
    }
  )

  it('routes existing owner seams and passes the exact caller lease to owned resources', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const managedInvocation = invocation([
      { source: 'local' as const, path: '/managed/report' }
    ] as const)
    const uploadInvocation = invocation([
      { transferId: 'transfer-1', offset: 0, chunk: new Uint8Array([1]) }
    ] as const)

    await router.dispatcher.invoke(
      dataContentApplicationCommands.previewResourceAcquire,
      managedInvocation
    )
    await router.dispatcher.invoke(
      dataContentApplicationCommands.uploadAppendTransfer,
      uploadInvocation
    )
    await router.dispatcher.invoke(
      dataContentApplicationCommands.projectFilesRepairIndex,
      invocation([{ projectId: 'project-1' }] as const)
    )
    await router.dispatcher.invoke(
      dataContentApplicationCommands.previewLoad,
      invocation([{ projectId: 'project-1' }] as const)
    )

    expect(deps.managedPreview.acquire).toHaveBeenCalledWith(
      managedInvocation.callerLease,
      managedInvocation.args[0]
    )
    expect(deps.uploads.appendTransfer).toHaveBeenCalledWith(uploadInvocation)
    expect(deps.projectFiles.repairIndex).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(deps.preview.load).toHaveBeenCalledWith({ projectId: 'project-1' })
  })

  it('keeps artifact finalization recovery and local-file authority unchanged', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const finalizeRequest = { claimId: 'claim-1', messageId: 'message-1' }

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.artifactFinalizeRun,
        invocation([finalizeRequest] as const)
      )
    ).resolves.toEqual({ ok: true, artifacts: [] })

    deps.artifacts.finalizeRunArtifacts.mockRejectedValueOnce(
      new ArtifactOwnershipPersistenceRaceError('ownership is pending')
    )
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.artifactFinalizeRun,
        invocation([finalizeRequest] as const)
      )
    ).resolves.toEqual({
      ok: false,
      code: 'ownership-persistence-race',
      message: 'ownership is pending'
    })

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.artifactOpenFile,
        invocation([{ path: 'artifact://report' }] as const, remoteCaller)
      )
    ).rejects.toThrow('Channel only available from the local app: artifacts:open-file')
    expect(deps.artifacts.openFile).not.toHaveBeenCalled()

    await router.dispatcher.invoke(
      dataContentApplicationCommands.artifactOpenFile,
      invocation([{ path: 'artifact://report' }] as const)
    )
    expect(deps.artifacts.openFile).toHaveBeenCalledWith({ path: 'artifact://report' })
  })

  it('classifies permanent artifact finalization proof failures for public transports', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    deps.artifacts.finalizeRunArtifacts.mockRejectedValueOnce(
      new ArtifactFinalizationProofError(
        'version-message-conflict',
        'Artifact Version private-version-id is already finalized to a different message.'
      )
    )

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.artifactFinalizeRun,
        invocation([{ claimId: 'claim-1', messageId: 'message-1' }] as const)
      )
    ).rejects.toMatchObject({
      name: 'ApplicationCommandError',
      code: 'command-failed',
      message:
        'Artifact finalization was rejected because its ownership no longer matches the saved Session.'
    })
  })

  it('publishes project and session mutations after durable owner completion without failing commits', async () => {
    const order: string[] = []
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    deps.projects.create.mockImplementationOnce(async () => {
      order.push('project:commit')
      return deps.project
    })
    deps.sessions.saveSession.mockImplementationOnce(async () => {
      order.push('session:commit')
      return { created: true, session: deps.session }
    })
    deps.events.publish.mockImplementation((channel: string) => {
      order.push(`publish:${channel}`)
      throw new Error('renderer disconnected')
    })
    deps.withDataRootWrite.mockImplementation(async <Result>(operation: () => Promise<Result>) => {
      order.push('write:start')
      const result = await operation()
      order.push('write:end')
      return result
    })
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.projectCreate,
        invocation([{ name: 'Project' }] as const)
      )
    ).resolves.toBe(deps.project)
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionSave,
        invocation([deps.session] as const)
      )
    ).resolves.toBe(deps.session)

    expect(order).toEqual([
      'write:start',
      'project:commit',
      'publish:project:created',
      'write:end',
      'write:start',
      'session:commit',
      'publish:session:created',
      'write:end'
    ])
    expect(deps.events.publish).toHaveBeenLastCalledWith('session:created', {
      session: deps.session,
      originClientId: 'web:renderer-1'
    })
  })

  it('rejects Project repository access while a data-root migration is pending', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    deps.withDataRootWrite.mockImplementation(withDataRootWrite)
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const operations = [
      {
        command: 'projectCreate' as const,
        args: [{ name: 'Project' }]
      },
      {
        command: 'projectGet' as const,
        args: ['project-1']
      },
      {
        command: 'projectList' as const,
        args: []
      },
      {
        command: 'projectUpdateArchive' as const,
        args: [{ id: 'project-1', archived: true, expectedArchivedAt: null }]
      },
      {
        command: 'projectUpdate' as const,
        args: [{ id: 'project-1', name: 'Updated project', expectedUpdatedAt: 1 }]
      }
    ]

    beginMigration()
    try {
      for (const operation of operations) {
        await expect(
          dispatchCommand(router, operation.command, operation.args).result
        ).rejects.toThrow('Open Science is moving your data.')
      }
    } finally {
      clearMigrationPending()
    }

    expect(deps.projects.create).not.toHaveBeenCalled()
    expect(deps.projects.get).not.toHaveBeenCalled()
    expect(deps.projects.list).not.toHaveBeenCalled()
    expect(deps.projects.updateArchive).not.toHaveBeenCalled()
    expect(deps.projects.update).not.toHaveBeenCalled()
  })

  it('keeps migration drain pending until an already-started Project operation finishes', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    let finishProject: (() => void) | undefined
    deps.projects.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProject = () => resolve(deps.project)
        })
    )
    deps.withDataRootWrite.mockImplementation(withDataRootWrite)
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    const projectResult = dispatchCommand(router, 'projectCreate', [{ name: 'Project' }]).result
    await vi.waitFor(() => expect(finishProject).toBeTypeOf('function'))

    beginMigration()
    let drained = false
    const drain = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()

    try {
      expect(drained).toBe(false)
      finishProject?.()
      await expect(projectResult).resolves.toBe(deps.project)
      await drain
      expect(drained).toBe(true)
    } finally {
      finishProject?.()
      clearMigrationPending()
      await projectResult.catch(() => undefined)
    }
  })

  it('preserves the Session revision conflict code across the application command boundary', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    deps.sessions.saveSession.mockRejectedValueOnce(new SessionRevisionConflictError(1, 2))
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionSave,
        invocation([deps.session] as const)
      )
    ).rejects.toMatchObject({
      code: 'session-revision-conflict',
      message: expect.stringContaining('expected 1, actual 2')
    })
    expect(deps.events.publish).not.toHaveBeenCalled()
  })

  it('preserves the Session details conflict code across the application command boundary', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    deps.sessions.editDetails.mockRejectedValueOnce(new SessionDetailsConflictError())
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionEditDetails,
        invocation([
          {
            projectId: 'project-1',
            sessionId: 'session-1',
            expectedTitle: 'Session',
            expectedDescription: '',
            title: 'Edited',
            description: ''
          }
        ] as const)
      )
    ).rejects.toMatchObject({
      code: 'session-details-conflict'
    })
    expect(deps.events.publish).not.toHaveBeenCalled()
  })

  it('allows current Electron/Web humans and Task automation to update main-owned delegation policy', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const args = ['project-1', 'session-1', 'deny'] as const

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionSetDelegationPolicy,
        invocation(args, createTaskCallerContext())
      )
    ).resolves.toBe(deps.session)
    expect(deps.sessions.setDelegationPolicy).toHaveBeenCalledWith(...args)
    expect(deps.events.publish).toHaveBeenCalledWith('session:updated', {
      session: deps.session,
      originClientId: MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID
    })

    for (const currentHuman of [electronCaller, callerContext, remoteCaller]) {
      await expect(
        router.dispatcher.invoke(
          dataContentApplicationCommands.sessionSetDelegationPolicy,
          invocation(args, currentHuman)
        )
      ).resolves.toBe(deps.session)
    }
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionSetDelegationPolicy,
        invocation(args, createTaskCallerContext({ isAuthorizationCurrent: () => false }))
      )
    ).rejects.toThrow('Caller authorization is no longer current.')
    const rejectedCallers = [
      createWebCallerContext('agent', {
        principalKind: 'agent-session',
        actionOrigin: 'agent-session'
      }),
      createWebCallerContext('human-agent-origin', { actionOrigin: 'agent-session' }),
      createWebCallerContext('automation-human-origin', {
        principalKind: 'automation',
        actionOrigin: 'human'
      })
    ]
    for (const rejectedCaller of rejectedCallers) {
      await expect(
        router.dispatcher.invoke(
          dataContentApplicationCommands.sessionSetDelegationPolicy,
          invocation(args, rejectedCaller)
        )
      ).rejects.toThrow(
        'Channel only available from current human or Task automation: sessions:set-delegation-policy'
      )
    }
    expect(deps.sessions.setDelegationPolicy).toHaveBeenCalledTimes(4)
  })

  it('runtime-validates delegation policy arguments and shared authoritative Session results', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionSetDelegationPolicy,
        invocation(['project-1', 'session-1', 'sometimes'] as never)
      )
    ).rejects.toMatchObject({ code: 'invalid-command-arguments' })
    expect(deps.sessions.setDelegationPolicy).not.toHaveBeenCalled()

    deps.sessions.setDelegationPolicy.mockResolvedValueOnce({ id: 'malformed' } as never)
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionSetDelegationPolicy,
        invocation(['project-1', 'session-1', 'allow'] as const)
      )
    ).rejects.toMatchObject({ code: 'invalid-command-result' })

    deps.sessions.editDetails.mockResolvedValueOnce({ id: 'malformed' } as never)
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionEditDetails,
        invocation([
          {
            projectId: 'project-1',
            sessionId: 'session-1',
            expectedTitle: 'Session',
            expectedDescription: '',
            title: 'Updated title',
            description: 'Updated description'
          }
        ] as const)
      )
    ).rejects.toMatchObject({ code: 'invalid-command-result' })
  })

  it('allows only Task automation to atomically update authoritative Session configuration', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const configured = {
      ...deps.session,
      revision: 5,
      memoryEnabled: false,
      delegationPolicy: 'deny' as const,
      enabledComputeHosts: ['ssh:alpha'],
      selectedComputeHosts: ['ssh:alpha']
    }
    deps.sessions.updateSessionConfiguration.mockResolvedValueOnce(configured)

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionUpdateConfiguration,
        invocation([configured, 4] as const, createTaskCallerContext())
      )
    ).resolves.toEqual(configured)
    expect(deps.sessions.updateSessionConfiguration).toHaveBeenCalledWith(configured, 4)
    expect(deps.events.publish).toHaveBeenCalledWith('session:updated', {
      session: configured,
      originClientId: 'web:headless-task-api'
    })

    for (const rejectedCaller of [electronCaller, callerContext, remoteCaller]) {
      await expect(
        router.dispatcher.invoke(
          dataContentApplicationCommands.sessionUpdateConfiguration,
          invocation([configured, 5] as const, rejectedCaller)
        )
      ).rejects.toThrow(
        'Channel only available from Task automation: sessions:update-configuration'
      )
    }
    expect(deps.sessions.updateSessionConfiguration).toHaveBeenCalledOnce()
  })

  it('keeps Project Session defaults behind the Task-only validated command', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const request = {
      id: deps.project.id,
      expectedUpdatedAt: deps.project.updatedAt,
      sessionDefaults: { memoryEnabled: false }
    }

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.projectUpdate,
        invocation([request] as const)
      )
    ).rejects.toThrow(
      'Project Session defaults must be changed through the Task configuration API.'
    )
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.projectUpdateSessionDefaults,
        invocation([request] as const, callerContext)
      )
    ).rejects.toThrow(
      'Channel only available from Task automation: projects:update-session-defaults'
    )
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.projectUpdateSessionDefaults,
        invocation([request] as const, createTaskCallerContext())
      )
    ).resolves.toBe(deps.project)
    expect(deps.projects.update).toHaveBeenCalledOnce()
    expect(deps.projects.update).toHaveBeenCalledWith(request)
  })

  it('preserves configuration revision conflicts across the Task command boundary', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    deps.sessions.updateSessionConfiguration.mockRejectedValueOnce(
      new SessionRevisionConflictError(4, 5)
    )
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionUpdateConfiguration,
        invocation([{ ...deps.session, revision: 4 }, 4] as const, createTaskCallerContext())
      )
    ).rejects.toMatchObject({ code: 'session-revision-conflict' })
    expect(deps.events.publish).not.toHaveBeenCalled()
  })

  it('sanitizes the complete authoritative Session result instead of passing malformed fields', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    deps.sessions.editDetails.mockResolvedValueOnce({
      ...deps.session,
      status: 'future-status',
      revision: -1,
      createdAt: 'yesterday',
      updatedAt: Number.NaN,
      runtimeContext: { version: 1, revision: 'invalid' }
    } as never)
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    const result = await router.dispatcher.invoke(
      dataContentApplicationCommands.sessionEditDetails,
      invocation([
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          expectedTitle: 'Session',
          expectedDescription: '',
          title: 'Updated title',
          description: 'Updated description'
        }
      ] as const)
    )

    expect(result).toMatchObject({ status: 'idle', revision: 0, createdAt: 0, updatedAt: 0 })
    expect(result.runtimeContext).toBeUndefined()
  })

  it('rejects a malformed Session conversation graph returned by archive', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    deps.sessions.updateArchive.mockResolvedValueOnce({
      ...deps.session,
      conversationGraph: { schemaVersion: 1 }
    } as never)
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionUpdateArchive,
        invocation([
          {
            projectId: 'project-1',
            sessionId: 'session-1',
            archived: true,
            expectedArchivedAt: null
          }
        ] as const)
      )
    ).rejects.toMatchObject({ code: 'invalid-command-result' })
  })

  it('sanitizes a renderer Session once at the main-process save boundary', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    const malformedSession = {
      ...deps.session,
      status: 'future-status',
      revision: -1,
      createdAt: 'yesterday',
      runtimeContext: { version: 1, revision: 'invalid' }
    }
    await dispatchCommand(router, 'sessionSave', [malformedSession]).result

    expect(deps.sessions.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'idle', revision: 0, createdAt: 0 }),
      undefined
    )
    const savedSession = (
      deps.sessions.saveSession.mock.calls as unknown as Array<readonly [Record<string, unknown>]>
    )[0]?.[0]
    expect(savedSession?.runtimeContext).toBeUndefined()
  })

  it('grants Task callers authority to advance the Task Run commit witness', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await dispatchCommand(
      router,
      'sessionSave',
      [{ ...deps.session, taskRunCommitId: 'run-1' }],
      createTaskCallerContext()
    ).result

    expect(deps.sessions.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ taskRunCommitId: 'run-1' }),
      undefined,
      { taskRunCommit: true }
    )
  })

  it('normalizes graph-only Session arguments and results without preserving incomplete objects', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    const graphOnlySession: Partial<PersistedChatSession> = structuredClone(
      materializeSessionConversationGraph(deps.session as PersistedChatSession)
    )
    delete graphOnlySession.messages
    deps.sessions.updateArchive.mockResolvedValueOnce(graphOnlySession as never)
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await dispatchCommand(router, 'sessionSave', [graphOnlySession]).result
    const submitted = (
      deps.sessions.saveSession.mock.calls as unknown as Array<readonly [PersistedChatSession]>
    )[0]?.[0]
    expect(submitted?.messages).toEqual([])

    const result = await router.dispatcher.invoke(
      dataContentApplicationCommands.sessionUpdateArchive,
      invocation([
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          archived: true,
          expectedArchivedAt: null
        }
      ] as const)
    )
    expect(result).not.toBe(graphOnlySession)
    expect(result.messages).toEqual([])
  })

  it('normalizes incomplete nested Session messages before persistence', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await dispatchCommand(router, 'sessionSave', [
      {
        ...deps.session,
        messages: [{ id: 'message-1', role: 'user', content: 'Hello' }]
      }
    ]).result

    const submitted = (
      deps.sessions.saveSession.mock.calls as unknown as Array<readonly [PersistedChatSession]>
    )[0]?.[0]
    expect(submitted?.messages[0]).toMatchObject({
      status: 'complete',
      eventIds: [],
      createdAt: 0,
      updatedAt: 0
    })
  })

  it('preserves legacy upload paths through live save and archive command boundaries', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    const legacyPath = '/data/uploads/project-1/session-1/legacy.csv'
    const legacySession = materializeSessionConversationGraph({
      ...deps.session,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Analyze this upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: legacyPath,
              size: 12
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    } as PersistedChatSession)
    deps.sessions.updateArchive.mockResolvedValueOnce(legacySession as never)
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await dispatchCommand(router, 'sessionSave', [legacySession]).result
    const submitted = (
      deps.sessions.saveSession.mock.calls as unknown as Array<readonly [PersistedChatSession]>
    )[0]?.[0]
    expect(submitted?.messages[0]?.uploads?.[0]).toMatchObject({ path: legacyPath })

    const archived = await router.dispatcher.invoke(
      dataContentApplicationCommands.sessionUpdateArchive,
      invocation([
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          archived: true,
          expectedArchivedAt: null
        }
      ] as const)
    )
    expect(archived.messages[0]?.uploads?.[0]).toMatchObject({ path: legacyPath })
  })

  it('dispatches every remaining Project and Session wrapper to its existing owner', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    const loadResult = { sessions: [], manifest: { version: 1 as const } }
    const listResult = { sessions: [], manifest: { version: 1 as const } }
    const usageResult = {
      sessionCreatedAt: [],
      projectCreatedAt: [],
      artifactCreatedAt: [],
      runsAt: [],
      usageEvents: [],
      totalArtifacts: 0
    }
    const loadedSession = deps.session
    deps.sessions.list.mockResolvedValueOnce(listResult)
    deps.sessions.loadAll.mockResolvedValueOnce(loadResult)
    deps.sessions.loadOne.mockResolvedValueOnce(loadedSession)
    deps.sessions.loadUsage.mockResolvedValueOnce(usageResult)
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const updateRequest = { id: 'project-1', name: 'Updated project', expectedUpdatedAt: 1 }
    const deleteProjectRequest = { id: 'project-1' }
    const manifestRequest = { lastSessionId: 'session-1' }
    const deleteSessionRequest = { projectId: 'project-1', sessionId: 'session-1' }
    const editDetailsRequest = {
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedTitle: 'Session',
      expectedDescription: '',
      title: 'Edited',
      description: 'Description'
    }

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.projectUpdate,
        invocation([updateRequest] as const)
      )
    ).resolves.toBe(deps.project)
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.projectDelete,
        invocation([deleteProjectRequest] as const)
      )
    ).resolves.toEqual({ status: 'cleanup-pending' })
    await expect(
      router.dispatcher.invoke(dataContentApplicationCommands.sessionLoadAll, invocation([]))
    ).resolves.toBe(loadResult)
    await expect(
      router.dispatcher.invoke(dataContentApplicationCommands.sessionList, invocation([]))
    ).resolves.toBe(listResult)
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionLoadOne,
        invocation([deleteSessionRequest] as const)
      )
    ).resolves.toBe(loadedSession)
    await expect(
      router.dispatcher.invoke(dataContentApplicationCommands.sessionLoadUsage, invocation([]))
    ).resolves.toBe(usageResult)
    await router.dispatcher.invoke(
      dataContentApplicationCommands.sessionSaveManifest,
      invocation([manifestRequest] as const)
    )
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionDelete,
        invocation([deleteSessionRequest] as const)
      )
    ).resolves.toEqual({ status: 'deleted', runtimeDetached: true })
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionEditDetails,
        invocation([editDetailsRequest] as const)
      )
    ).resolves.toBe(deps.session)

    expect(deps.projects.update).toHaveBeenCalledWith(updateRequest)
    expect(deps.projects.delete).toHaveBeenCalledWith('project-1')
    expect(deps.sessions.loadAll).toHaveBeenCalledOnce()
    expect(deps.sessions.list).toHaveBeenCalledOnce()
    expect(deps.sessions.loadOne).toHaveBeenCalledWith(deleteSessionRequest)
    expect(deps.sessions.loadUsage).toHaveBeenCalledOnce()
    expect(deps.sessions.saveManifest).toHaveBeenCalledWith(manifestRequest)
    expect(deps.sessions.deleteSession).toHaveBeenCalledWith(deleteSessionRequest)
    expect(deps.sessions.editDetails).toHaveBeenCalledWith(editDetailsRequest)
    expect(deps.withDataRootWrite).toHaveBeenCalledTimes(7)
    expect(deps.events.publish).toHaveBeenCalledWith('project:updated', deps.project)
    expect(deps.events.publish).not.toHaveBeenCalledWith('project:deleted', expect.anything())
    expect(deps.events.publish).toHaveBeenCalledWith('session:deleted', deleteSessionRequest)
  })

  it('returns a failed Session deletion without publishing a committed lifecycle event', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    const request = { projectId: 'project-1', sessionId: 'session-1' }
    const result = {
      status: 'failed' as const,
      reason: 'runtime' as const,
      runtimeDetached: false as const
    }
    deps.sessions.deleteSession.mockResolvedValueOnce(result)
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionDelete,
        invocation([request] as const)
      )
    ).resolves.toEqual(result)

    expect(deps.sessions.deleteSession).toHaveBeenCalledWith(request)
    expect(deps.withDataRootWrite).not.toHaveBeenCalled()
    expect(deps.events.publish).not.toHaveBeenCalledWith('session:deleted', request)
  })

  it.each([
    {
      label: 'unknown extra field',
      request: { projectId: 'project-1', sessionId: 'session-1', force: true }
    },
    { label: 'empty project id', request: { projectId: '', sessionId: 'session-1' } },
    { label: 'empty session id', request: { projectId: 'project-1', sessionId: '' } },
    { label: 'missing session id', request: { projectId: 'project-1' } },
    { label: 'scalar payload', request: 'session-1' }
  ])(
    'rejects a malformed Session deletion request ($label) before reaching the owner',
    async ({ request }) => {
      const router = createApplicationCommandRouter()
      const deps = createDependencies()
      registerDataContentApplicationCommands(router.registrar, deps.dependencies)

      // Malformed payloads are intentionally outside the command's static arg type; dispatch
      // through the type-widened harness so the runtime codec is what rejects them.
      const { result: dispatched } = dispatchCommand(router, 'sessionDelete', [request])

      const error = await dispatched.catch((error: unknown) => error)
      expect(error).toBeInstanceOf(ApplicationCommandError)
      expect(error).toMatchObject({ code: 'invalid-command-arguments' })
      expect(deps.sessions.deleteSession).not.toHaveBeenCalled()
      expect(deps.events.publish).not.toHaveBeenCalled()
    }
  )

  it.each([
    {
      label: 'archive request with a surplus field',
      command: 'sessionUpdateArchive' as const,
      request: {
        projectId: 'project-1',
        sessionId: 'session-1',
        archived: true,
        expectedArchivedAt: null,
        force: true
      },
      owner: 'updateArchive' as const
    },
    {
      label: 'archive request with an invalid timestamp',
      command: 'sessionUpdateArchive' as const,
      request: {
        projectId: 'project-1',
        sessionId: 'session-1',
        archived: false,
        expectedArchivedAt: Number.NaN
      },
      owner: 'updateArchive' as const
    },
    {
      label: 'manifest request with the removed project id',
      command: 'sessionSaveManifest' as const,
      request: { lastProjectId: 'project-1', lastSessionId: 'session-1' },
      owner: 'saveManifest' as const
    },
    {
      label: 'manifest request with a surplus field',
      command: 'sessionSaveManifest' as const,
      request: { lastSessionId: 'session-1', path: '/private/data' },
      owner: 'saveManifest' as const
    }
  ])('rejects a malformed Session $label before reaching the owner', async (testCase) => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    const { result: dispatched } = dispatchCommand(router, testCase.command, [testCase.request])

    await expect(dispatched).rejects.toMatchObject({ code: 'invalid-command-arguments' })
    expect(deps.sessions[testCase.owner]).not.toHaveBeenCalled()
  })

  it('rejects a malformed Session deletion owner result without publishing deletion', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    deps.sessions.deleteSession.mockResolvedValueOnce({
      status: 'failed',
      reason: 'runtime',
      runtimeDetached: 'yes'
    } as unknown as SessionDeletionResult)
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    const dispatched = router.dispatcher.invoke(
      dataContentApplicationCommands.sessionDelete,
      invocation([{ projectId: 'project-1', sessionId: 'session-1' }] as const)
    )

    const error = await dispatched.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ApplicationCommandError)
    expect(error).toMatchObject({ code: 'invalid-command-result' })
    expect(deps.sessions.deleteSession).toHaveBeenCalledTimes(1)
    expect(deps.events.publish).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'unknown extra field',
      request: {
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedTitle: 'Session',
        expectedDescription: '',
        title: 'Edited',
        description: '',
        force: true
      }
    },
    {
      label: 'empty session id',
      request: {
        projectId: 'project-1',
        sessionId: '',
        expectedTitle: 'Session',
        expectedDescription: '',
        title: 'Edited',
        description: ''
      }
    },
    {
      label: 'missing description',
      request: {
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedTitle: 'Session',
        expectedDescription: '',
        title: 'Edited'
      }
    },
    {
      label: 'missing expected title',
      request: {
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedDescription: '',
        title: 'Edited',
        description: ''
      }
    }
  ])('rejects a malformed Session details edit request ($label)', async ({ request }) => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)

    const { result: dispatched } = dispatchCommand(router, 'sessionEditDetails', [request])

    await expect(dispatched).rejects.toMatchObject({ code: 'invalid-command-arguments' })
    expect(deps.sessions.editDetails).not.toHaveBeenCalled()
  })

  it('accepts the legacy Web RPC v1 Session details request without edit baselines', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      title: 'Edited',
      description: 'Description'
    }

    const { result: dispatched } = dispatchCommand(router, 'sessionEditDetails', [request])

    await expect(dispatched).resolves.toBe(deps.session)
    expect(deps.sessions.editDetails).toHaveBeenCalledWith(request)
  })

  it('keeps native and local upload/export capability restrictions and standalone invalidation', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    registerDataContentApplicationCommands(router.registrar, deps.dependencies)
    const nativeUpload = {
      transferId: 'transfer-1',
      sourcePath: '/tmp/report.txt',
      name: 'report.txt',
      size: 10
    }
    const pathUpload = {
      transferId: 'transfer-2',
      sourcePath: '/tmp/report.txt',
      name: 'report.txt',
      projectId: 'project-1'
    }

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.uploadStageLocalFile,
        invocation([nativeUpload] as const)
      )
    ).rejects.toThrow('Channel only available from the Electron app: uploads:stage-local-file')
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionExportConversation,
        invocation([
          { projectId: 'project-1', sessionId: 'session-1', format: 'markdown' }
        ] as const)
      )
    ).rejects.toThrow('Channel only available from the Electron app: sessions:export-conversation')
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.uploadStageLocalPath,
        invocation([pathUpload] as const, remoteCaller)
      )
    ).rejects.toThrow('Channel only available from the local app: uploads:stage-local-path')

    const exportRequest = {
      projectId: 'project-1',
      sessionId: 'session-1',
      format: 'markdown' as const,
      selectedPromptMessageIds: ['prompt-1']
    }
    const exportInvocation = invocation([exportRequest] as const, electronCaller)
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.sessionExportConversation,
        exportInvocation
      )
    ).resolves.toEqual({ saved: false })
    expect(deps.electron.exportConversationFromInvokingWindow).toHaveBeenCalledWith(
      exportInvocation
    )
    const nativeUploadInvocation = invocation([nativeUpload] as const, electronCaller)
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.uploadStageLocalFile,
        nativeUploadInvocation
      )
    ).resolves.toBe(deps.attachment)
    expect(deps.electron.stageLocalFileWithProgress).toHaveBeenCalledWith(nativeUploadInvocation)
    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.uploadStageLocalPath,
        invocation([pathUpload] as const)
      )
    ).resolves.toBe(deps.attachment)
    expect(deps.events.publish).toHaveBeenCalledWith('project-files:changed', {
      projectId: 'project-1',
      sessionId: 'standalone-uploads',
      sources: ['upload'],
      kind: 'upsert'
    })
  })

  it('returns a committed standalone upload when one event subscriber fails', async () => {
    const router = createApplicationCommandRouter()
    const deps = createDependencies()
    const events = new ApplicationEventHub()
    const publicationFailure = new Error('renderer broadcast failed')
    const laterSubscriber = vi.fn()
    events.subscribe(() => {
      throw publicationFailure
    })
    events.subscribe(laterSubscriber)
    registerDataContentApplicationCommands(router.registrar, {
      ...deps.dependencies,
      events
    })
    const request = {
      transferId: 'transfer-standalone',
      sourcePath: '/tmp/report.txt',
      name: 'report.txt',
      projectId: 'project-1'
    }

    await expect(
      router.dispatcher.invoke(
        dataContentApplicationCommands.uploadStageLocalPath,
        invocation([request] as const)
      )
    ).resolves.toBe(deps.attachment)
    expect(deps.uploads.stageLocalPath).toHaveBeenCalledOnce()
    expect(laterSubscriber).toHaveBeenCalledWith({
      channel: 'project-files:changed',
      payload: {
        projectId: 'project-1',
        sessionId: 'standalone-uploads',
        sources: ['upload'],
        kind: 'upsert'
      }
    })
  })
})
