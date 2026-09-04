import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar,
  type ApplicationInvocation
} from './application-command-router'
import type { ApplicationEventMap, ApplicationEventPublisher } from './application-events'
import type { ArtifactHandlers } from './artifacts/ipc'
import {
  ArtifactFinalizationProofError,
  ArtifactOwnershipPersistenceRaceError
} from './artifacts/provenance-repository'
import type { ProjectFilesHandlers } from './project-files/ipc'
import type { ProjectHandlers } from './projects/ipc'
import type { SessionPersistenceHandlers } from './session-persistence/ipc'
import type { ManagedPreviewOwnerRegistry } from './managed-preview-ipc'
import { canMutateSessionDelegationPolicy } from './caller-context'

import {
  ApplicationCommandError,
  type ApplicationCommandContract
} from '../shared/application-command-contract'
import * as Artifacts from '../shared/artifacts'
import type * as ConversationExport from '../shared/conversation-export'
import {
  LIFECYCLE_CHANNELS,
  MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID
} from '../shared/lifecycle-events'
import type * as PreviewResources from '../shared/preview-resources'
import type * as PreviewState from '../shared/preview-state'
import * as Projects from '../shared/projects'
import * as SessionPersistence from '../shared/session-persistence'
import * as Uploads from '../shared/uploads'

type OwnerArgs<Owner, Method extends keyof Owner> = Owner[Method] extends (
  ...args: infer Args
) => unknown
  ? Readonly<Args>
  : never

type OwnerResult<Owner, Method extends keyof Owner> = Owner[Method] extends (
  ...args: never[]
) => infer Result
  ? Awaited<Result>
  : never

const commandFor =
  <Owner>() =>
  <const Name extends string, Method extends keyof Owner>(
    name: Name,
    method: Method,
    contract?: ApplicationCommandContract<OwnerArgs<Owner, Method>, OwnerResult<Owner, Method>>
  ) => {
    void method
    return defineApplicationCommand<Name, OwnerArgs<Owner, Method>, OwnerResult<Owner, Method>>(
      name,
      contract
    )
  }

type InvocationArgs<Owner, Method extends keyof Owner> = Owner[Method] extends (
  invocation: ApplicationInvocation<infer Args>
) => unknown
  ? Args
  : never

const invocationCommandFor =
  <Owner>() =>
  <const Name extends string, Method extends keyof Owner>(
    name: Name,
    method: Method,
    contract?: ApplicationCommandContract<InvocationArgs<Owner, Method>, OwnerResult<Owner, Method>>
  ) => {
    void method
    return defineApplicationCommand<
      Name,
      InvocationArgs<Owner, Method>,
      OwnerResult<Owner, Method>
    >(name, contract)
  }

type PreviewApplicationCommandOwner = Readonly<{
  load(
    request: PreviewState.LoadPreviewStateRequest
  ): Promise<PreviewState.PreviewStateSnapshot | null>
  save(request: PreviewState.SavePreviewStateRequest): Promise<PreviewState.SavePreviewStateResult>
  delete(request: PreviewState.DeletePreviewStateRequest): Promise<void>
}>

type SessionApplicationCommandOwner = Omit<SessionPersistenceHandlers, 'deleteSession'> & {
  stageTaskCompletion(
    request: SessionPersistence.StageTaskSessionCompletionRequest
  ): Promise<SessionPersistence.PersistedChatSession>
  settleTaskCompletion(
    request: SessionPersistence.SettleTaskSessionCompletionRequest
  ): Promise<SessionPersistence.PersistedChatSession>
  failTaskRun(
    request: SessionPersistence.FailTaskSessionRunRequest
  ): Promise<SessionPersistence.PersistedChatSession>
  filterPdfContextCandidates(
    request: SessionPersistence.FilterSessionPdfContextCandidatesRequest
  ): Promise<SessionPersistence.FilterSessionPdfContextCandidatesResult>
  linkPdfContext(
    request: SessionPersistence.LinkSessionPdfContextRequest
  ): Promise<SessionPersistence.SessionRuntimeContext>
  unlinkPdfContext(
    request: SessionPersistence.UnlinkSessionPdfContextRequest
  ): Promise<SessionPersistence.SessionRuntimeContext>
  editDetails(
    request: SessionPersistence.EditSessionDetailsRequest
  ): Promise<SessionPersistence.PersistedChatSession>
  updateSessionConfiguration(
    session: SessionPersistence.PersistedChatSession,
    expectedRevision: number
  ): Promise<SessionPersistence.PersistedChatSession>
  deleteSession(
    request: SessionPersistence.DeleteSessionRequest
  ): Promise<SessionPersistence.SessionDeletionResult>
}

type InvocationOwner<Owner> = Readonly<{
  [Method in keyof Owner]: Owner[Method] extends (...args: infer Args) => infer Result
    ? (invocation: ApplicationInvocation<Readonly<Args>>) => Result
    : never
}>

// T2h0 injects this adapter; it resolves native window/progress targets without putting Electron
// objects in transport-neutral application invocations.
type ElectronDataContentApplicationCommandAdapter = InvocationOwner<{
  exportConversationFromInvokingWindow: (
    request: ConversationExport.ExportConversationRequest
  ) => Promise<ConversationExport.ExportConversationResult>
  stageLocalFileWithProgress: (
    request: Uploads.StageLocalUploadRequest
  ) => Promise<Uploads.UploadedAttachment>
}>

type ManagedPreviewApplicationCommandOwner = ManagedPreviewOwnerRegistry

type UploadApplicationCommandOwner = InvocationOwner<{
  claimLocalFile: (request: Uploads.UploadTransferRequest) => void
  stageLocalPath: (
    request: Uploads.StageLocalPathUploadRequest
  ) => Promise<Uploads.UploadedAttachment>
  beginTransfer: (
    request: Uploads.BeginUploadTransferRequest
  ) => Promise<Uploads.UploadTransferStatus>
  appendTransfer: (
    request: Uploads.AppendUploadTransferRequest
  ) => Promise<Uploads.UploadTransferStatus>
  transferStatus: (
    request: Uploads.UploadTransferRequest
  ) => Promise<Uploads.UploadTransferStatus | null>
  finishTransfer: (request: Uploads.UploadTransferRequest) => Promise<Uploads.UploadedAttachment>
  abortTransfer: (request: Uploads.UploadTransferRequest) => Promise<void>
  deleteUpload: (request: Uploads.DeleteUploadRequest) => Promise<void>
  finalizeSession: (
    request: Uploads.FinalizeUploadSessionRequest
  ) => Promise<Uploads.UploadedAttachment[]>
  readPreview: (
    request: Artifacts.ReadArtifactPreviewRequest
  ) => Promise<Artifacts.ArtifactPreviewResult>
}>

type DataRootWrite = <Result>(operation: () => Promise<Result>) => Promise<Result>

type DataContentApplicationCommandDependencies = Readonly<{
  artifacts: ArtifactHandlers
  electron: ElectronDataContentApplicationCommandAdapter
  events: ApplicationEventPublisher
  managedPreview: ManagedPreviewApplicationCommandOwner
  preview: PreviewApplicationCommandOwner
  projectFiles: ProjectFilesHandlers
  projects: ProjectHandlers
  sessions: SessionApplicationCommandOwner
  uploads: UploadApplicationCommandOwner
  withDataRootWrite: DataRootWrite
}>

const artifactCommand = commandFor<ArtifactHandlers>()
const previewCommand = commandFor<PreviewApplicationCommandOwner>()
const projectFilesCommand = commandFor<ProjectFilesHandlers>()
const projectCommand = commandFor<ProjectHandlers>()
const sessionCommand = commandFor<SessionApplicationCommandOwner>()
const electronCommand = invocationCommandFor<ElectronDataContentApplicationCommandAdapter>()
const uploadCommand = invocationCommandFor<UploadApplicationCommandOwner>()

const dataContentApplicationCommands = Object.freeze({
  artifactFinalizeRun: defineApplicationCommand<
    'artifacts:finalize-run',
    readonly [request: Artifacts.FinalizeRunArtifactsRequest],
    Artifacts.FinalizeRunArtifactsResult
  >('artifacts:finalize-run'),
  artifactGenerateCodeReconstruction: artifactCommand(
    'artifacts:generate-code-reconstruction',
    'generateCodeReconstruction'
  ),
  artifactGetCodeReconstruction: artifactCommand(
    'artifacts:get-code-reconstruction',
    'getCodeReconstruction'
  ),
  artifactGetLineage: artifactCommand('artifacts:get-lineage', 'getLineage'),
  artifactGetVersionExecution: artifactCommand(
    'artifacts:get-version-execution',
    'getVersionExecution'
  ),
  artifactGetVersionMessages: artifactCommand(
    'artifacts:get-version-messages',
    'getVersionMessages'
  ),
  artifactGetVersionProvenance: artifactCommand(
    'artifacts:get-version-provenance',
    'getVersionProvenance'
  ),
  artifactGetVersionReview: artifactCommand('artifacts:get-version-review', 'getVersionReview'),
  artifactOpenFile: artifactCommand('artifacts:open-file', 'openFile'),
  artifactReadPreview: artifactCommand('artifacts:read-preview', 'readPreview'),
  artifactReconcilePending: artifactCommand(
    'artifacts:reconcile-pending',
    'reconcilePendingArtifacts'
  ),
  artifactResolveVersionDescriptors: artifactCommand(
    'artifacts:resolve-version-descriptors',
    'resolveVersionDescriptors'
  ),
  lifecycleClientId: defineApplicationCommand<'lifecycle:client-id', readonly [], string>(
    'lifecycle:client-id'
  ),
  previewDelete: previewCommand('preview:delete', 'delete'),
  previewLoad: previewCommand('preview:load', 'load'),
  previewSave: previewCommand('preview:save', 'save'),
  previewResourceAcquire: defineApplicationCommand<
    'preview-resources:acquire',
    readonly [request: PreviewResources.AcquireManagedPreviewRequest],
    PreviewResources.ManagedPreviewResource
  >('preview-resources:acquire'),
  previewResourceReadRange: defineApplicationCommand<
    'preview-resources:read-range',
    readonly [request: PreviewResources.ReadManagedPreviewRangeRequest],
    PreviewResources.ManagedPreviewRangeResult
  >('preview-resources:read-range'),
  previewResourceRelease: defineApplicationCommand<
    'preview-resources:release',
    readonly [request: PreviewResources.ReleaseManagedPreviewRequest],
    void
  >('preview-resources:release'),
  projectFilesGetOverview: projectFilesCommand('project-files:get-overview', 'getOverview'),
  projectFilesListArtifactGroups: projectFilesCommand(
    'project-files:list-artifact-groups',
    'listArtifactGroups'
  ),
  projectFilesListFiles: projectFilesCommand('project-files:list-files', 'listFiles'),
  projectFilesRepairIndex: projectFilesCommand('project-files:repair-index', 'repairIndex'),
  projectFilesResolveFile: projectFilesCommand('project-files:resolve-file', 'resolveFile'),
  projectFilesSearchArtifacts: projectFilesCommand(
    'project-files:search-artifacts',
    'searchArtifacts'
  ),
  projectCreate: projectCommand(
    'projects:create',
    'create',
    Projects.projectApplicationCommandContracts.create
  ),
  projectUpdateArchive: projectCommand(
    'projects:update-archive',
    'updateArchive',
    Projects.projectApplicationCommandContracts.updateArchive
  ),
  projectDelete: defineApplicationCommand<
    'projects:delete',
    readonly [request: Projects.DeleteProjectRequest],
    Projects.ProjectDeletionOutcome
  >('projects:delete', Projects.projectApplicationCommandContracts.delete),
  projectGet: projectCommand(
    'projects:get',
    'get',
    Projects.projectApplicationCommandContracts.get
  ),
  projectList: projectCommand(
    'projects:list',
    'list',
    Projects.projectApplicationCommandContracts.list
  ),
  projectListDeletionCleanup: projectCommand(
    'projects:list-deletion-cleanup',
    'listDeletionCleanup',
    Projects.projectApplicationCommandContracts.listDeletionCleanup
  ),
  projectRetryDeletionCleanup: projectCommand(
    'projects:retry-deletion-cleanup',
    'retryDeletionCleanup',
    Projects.projectApplicationCommandContracts.retryDeletionCleanup
  ),
  projectUpdate: projectCommand(
    'projects:update',
    'update',
    Projects.projectApplicationCommandContracts.update
  ),
  projectUpdateSessionDefaults: projectCommand(
    'projects:update-session-defaults',
    'update',
    Projects.projectApplicationCommandContracts.update
  ),
  sessionDelete: sessionCommand(
    'sessions:delete-session',
    'deleteSession',
    SessionPersistence.sessionApplicationCommandContracts.delete
  ),
  sessionEditDetails: sessionCommand(
    'sessions:edit-details',
    'editDetails',
    SessionPersistence.sessionApplicationCommandContracts.editDetails
  ),
  sessionExportConversation: electronCommand(
    'sessions:export-conversation',
    'exportConversationFromInvokingWindow'
  ),
  sessionList: sessionCommand('sessions:list', 'list'),
  sessionFilterPdfContextCandidates: sessionCommand(
    'sessions:filter-pdf-context-candidates',
    'filterPdfContextCandidates',
    SessionPersistence.sessionApplicationCommandContracts.filterPdfContextCandidates
  ),
  sessionLinkPdfContext: sessionCommand(
    'sessions:link-pdf-context',
    'linkPdfContext',
    SessionPersistence.sessionApplicationCommandContracts.linkPdfContext
  ),
  sessionLoadAll: sessionCommand('sessions:load-all', 'loadAll'),
  sessionLoadOne: sessionCommand('sessions:load-one', 'loadOne'),
  sessionLoadUsage: sessionCommand('sessions:load-usage', 'loadUsage'),
  sessionSaveManifest: sessionCommand(
    'sessions:save-manifest',
    'saveManifest',
    SessionPersistence.sessionApplicationCommandContracts.saveManifest
  ),
  sessionUpdateArchive: sessionCommand(
    'sessions:update-archive',
    'updateArchive',
    SessionPersistence.sessionApplicationCommandContracts.updateArchive
  ),
  sessionUnlinkPdfContext: sessionCommand(
    'sessions:unlink-pdf-context',
    'unlinkPdfContext',
    SessionPersistence.sessionApplicationCommandContracts.unlinkPdfContext
  ),
  sessionSave: defineApplicationCommand<
    'sessions:save-session',
    readonly [
      session: SessionPersistence.PersistedChatSession,
      options?: SessionPersistence.SaveSessionOptions
    ],
    SessionPersistence.PersistedChatSession
  >('sessions:save-session', SessionPersistence.sessionApplicationCommandContracts.save),
  sessionStageTaskCompletion: defineApplicationCommand<
    'sessions:stage-task-completion',
    readonly [request: SessionPersistence.StageTaskSessionCompletionRequest],
    SessionPersistence.PersistedChatSession
  >('sessions:stage-task-completion'),
  sessionSettleTaskCompletion: defineApplicationCommand<
    'sessions:settle-task-completion',
    readonly [request: SessionPersistence.SettleTaskSessionCompletionRequest],
    SessionPersistence.PersistedChatSession
  >('sessions:settle-task-completion'),
  sessionFailTaskRun: defineApplicationCommand<
    'sessions:fail-task-run',
    readonly [request: SessionPersistence.FailTaskSessionRunRequest],
    SessionPersistence.PersistedChatSession
  >('sessions:fail-task-run'),
  sessionSetDelegationPolicy: defineApplicationCommand<
    'sessions:set-delegation-policy',
    readonly [projectId: string, sessionId: string, policy: SessionPersistence.DelegationPolicy],
    SessionPersistence.PersistedChatSession
  >(
    'sessions:set-delegation-policy',
    SessionPersistence.sessionApplicationCommandContracts.setDelegationPolicy
  ),
  sessionUpdateConfiguration: defineApplicationCommand<
    'sessions:update-configuration',
    readonly [session: SessionPersistence.PersistedChatSession, expectedRevision: number],
    SessionPersistence.PersistedChatSession
  >(
    'sessions:update-configuration',
    SessionPersistence.sessionApplicationCommandContracts.updateConfiguration
  ),
  uploadAbortTransfer: uploadCommand('uploads:abort-transfer', 'abortTransfer'),
  uploadAppendTransfer: uploadCommand('uploads:append-transfer', 'appendTransfer'),
  uploadBeginTransfer: uploadCommand('uploads:begin-transfer', 'beginTransfer'),
  uploadClaimLocalFile: uploadCommand('uploads:claim-local-file', 'claimLocalFile'),
  uploadDelete: uploadCommand('uploads:delete', 'deleteUpload'),
  uploadFinalizeSession: uploadCommand(
    'uploads:finalize-session',
    'finalizeSession',
    Uploads.uploadApplicationCommandContracts.finalizeSession
  ),
  uploadFinishTransfer: uploadCommand('uploads:finish-transfer', 'finishTransfer'),
  uploadReadPreview: uploadCommand('uploads:read-preview', 'readPreview'),
  uploadStageLocalFile: electronCommand('uploads:stage-local-file', 'stageLocalFileWithProgress'),
  uploadStageLocalPath: uploadCommand('uploads:stage-local-path', 'stageLocalPath'),
  uploadTransferStatus: uploadCommand('uploads:transfer-status', 'transferStatus')
})

const dataContentApplicationCommandGroups = Object.freeze([
  defineApplicationCommandGroup('artifacts', [
    dataContentApplicationCommands.artifactFinalizeRun,
    dataContentApplicationCommands.artifactGenerateCodeReconstruction,
    dataContentApplicationCommands.artifactGetCodeReconstruction,
    dataContentApplicationCommands.artifactGetLineage,
    dataContentApplicationCommands.artifactGetVersionExecution,
    dataContentApplicationCommands.artifactGetVersionMessages,
    dataContentApplicationCommands.artifactGetVersionProvenance,
    dataContentApplicationCommands.artifactGetVersionReview,
    dataContentApplicationCommands.artifactOpenFile,
    dataContentApplicationCommands.artifactReadPreview,
    dataContentApplicationCommands.artifactReconcilePending,
    dataContentApplicationCommands.artifactResolveVersionDescriptors
  ] as const),
  defineApplicationCommandGroup('lifecycle', [
    dataContentApplicationCommands.lifecycleClientId
  ] as const),
  defineApplicationCommandGroup('preview', [
    dataContentApplicationCommands.previewDelete,
    dataContentApplicationCommands.previewLoad,
    dataContentApplicationCommands.previewSave
  ] as const),
  defineApplicationCommandGroup('preview-resources', [
    dataContentApplicationCommands.previewResourceAcquire,
    dataContentApplicationCommands.previewResourceReadRange,
    dataContentApplicationCommands.previewResourceRelease
  ] as const),
  defineApplicationCommandGroup('project-files', [
    dataContentApplicationCommands.projectFilesGetOverview,
    dataContentApplicationCommands.projectFilesListArtifactGroups,
    dataContentApplicationCommands.projectFilesListFiles,
    dataContentApplicationCommands.projectFilesRepairIndex,
    dataContentApplicationCommands.projectFilesResolveFile,
    dataContentApplicationCommands.projectFilesSearchArtifacts
  ] as const),
  defineApplicationCommandGroup('projects', [
    dataContentApplicationCommands.projectCreate,
    dataContentApplicationCommands.projectUpdateArchive,
    dataContentApplicationCommands.projectDelete,
    dataContentApplicationCommands.projectGet,
    dataContentApplicationCommands.projectList,
    dataContentApplicationCommands.projectListDeletionCleanup,
    dataContentApplicationCommands.projectRetryDeletionCleanup,
    dataContentApplicationCommands.projectUpdate,
    dataContentApplicationCommands.projectUpdateSessionDefaults
  ] as const),
  defineApplicationCommandGroup('sessions', [
    dataContentApplicationCommands.sessionDelete,
    dataContentApplicationCommands.sessionEditDetails,
    dataContentApplicationCommands.sessionExportConversation,
    dataContentApplicationCommands.sessionFilterPdfContextCandidates,
    dataContentApplicationCommands.sessionLinkPdfContext,
    dataContentApplicationCommands.sessionList,
    dataContentApplicationCommands.sessionLoadAll,
    dataContentApplicationCommands.sessionLoadOne,
    dataContentApplicationCommands.sessionLoadUsage,
    dataContentApplicationCommands.sessionSaveManifest,
    dataContentApplicationCommands.sessionUpdateArchive,
    dataContentApplicationCommands.sessionUnlinkPdfContext,
    dataContentApplicationCommands.sessionSave,
    dataContentApplicationCommands.sessionStageTaskCompletion,
    dataContentApplicationCommands.sessionSettleTaskCompletion,
    dataContentApplicationCommands.sessionFailTaskRun,
    dataContentApplicationCommands.sessionSetDelegationPolicy,
    dataContentApplicationCommands.sessionUpdateConfiguration
  ] as const),
  defineApplicationCommandGroup('uploads', [
    dataContentApplicationCommands.uploadAbortTransfer,
    dataContentApplicationCommands.uploadAppendTransfer,
    dataContentApplicationCommands.uploadBeginTransfer,
    dataContentApplicationCommands.uploadClaimLocalFile,
    dataContentApplicationCommands.uploadDelete,
    dataContentApplicationCommands.uploadFinalizeSession,
    dataContentApplicationCommands.uploadFinishTransfer,
    dataContentApplicationCommands.uploadReadPreview,
    dataContentApplicationCommands.uploadStageLocalFile,
    dataContentApplicationCommands.uploadStageLocalPath,
    dataContentApplicationCommands.uploadTransferStatus
  ] as const)
] as const)

const assertLocalCaller = (
  invocation: ApplicationInvocation<readonly unknown[]>,
  name: string
): void => {
  if (invocation.callerContext.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${name}`)
  }
}

const assertElectronCaller = (
  invocation: ApplicationInvocation<readonly unknown[]>,
  name: string
): void => {
  if (invocation.callerContext.surface !== 'electron') {
    throw new Error(`Channel only available from the Electron app: ${name}`)
  }
}

const assertSessionDelegationPolicyCaller = (
  invocation: ApplicationInvocation<readonly unknown[]>,
  name: string
): void => {
  const { callerContext } = invocation
  if (!canMutateSessionDelegationPolicy(callerContext)) {
    throw new Error(`Channel only available from current human or Task automation: ${name}`)
  }
}

const assertTaskCaller = (
  invocation: ApplicationInvocation<readonly unknown[]>,
  name: string
): void => {
  if (invocation.callerContext.surface !== 'task') {
    throw new Error(`Channel only available from Task automation: ${name}`)
  }
}

// Repository commits remain authoritative if compatibility publication fails, matching the current
// lifecycle broadcaster's non-fatal behavior.
const publishLifecycle = <Channel extends keyof ApplicationEventMap>(
  events: ApplicationEventPublisher,
  channel: Channel,
  payload: ApplicationEventMap[Channel]
): void => {
  try {
    events.publish(channel, payload)
  } catch {
    // A disconnected renderer cannot turn an already-committed mutation into a failed command.
  }
}

// Production composition registers all bounded command groups atomically; this group must not be
// exposed through a live transport in isolation.
const registerDataContentApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: DataContentApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()

  try {
    scope.registerGroup(dataContentApplicationCommandGroups[0], {
      'artifacts:finalize-run': async ({ args }) => {
        try {
          return {
            ok: true as const,
            artifacts: await dependencies.artifacts.finalizeRunArtifacts(args[0])
          }
        } catch (error) {
          if (error instanceof ArtifactOwnershipPersistenceRaceError) {
            return {
              ok: false as const,
              code: Artifacts.ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
              message: error.message
            }
          }
          if (error instanceof ArtifactFinalizationProofError) {
            throw new ApplicationCommandError(
              'command-failed',
              'Artifact finalization was rejected because its ownership no longer matches the saved Session.'
            )
          }
          throw error
        }
      },
      'artifacts:generate-code-reconstruction': ({ args }) =>
        dependencies.artifacts.generateCodeReconstruction(args[0]),
      'artifacts:get-code-reconstruction': ({ args }) =>
        dependencies.artifacts.getCodeReconstruction(args[0]),
      'artifacts:get-lineage': ({ args }) => dependencies.artifacts.getLineage(args[0]),
      'artifacts:get-version-execution': ({ args }) =>
        dependencies.artifacts.getVersionExecution(args[0]),
      'artifacts:get-version-messages': ({ args }) =>
        dependencies.artifacts.getVersionMessages(args[0]),
      'artifacts:get-version-provenance': ({ args }) =>
        dependencies.artifacts.getVersionProvenance(args[0]),
      'artifacts:get-version-review': ({ args }) =>
        dependencies.artifacts.getVersionReview(args[0]),
      'artifacts:open-file': (invocation) => {
        assertLocalCaller(invocation, dataContentApplicationCommands.artifactOpenFile.name)
        return dependencies.artifacts.openFile(invocation.args[0])
      },
      'artifacts:read-preview': ({ args }) => dependencies.artifacts.readPreview(args[0]),
      'artifacts:reconcile-pending': ({ args }) =>
        dependencies.artifacts.reconcilePendingArtifacts(args[0]),
      'artifacts:resolve-version-descriptors': ({ args }) =>
        dependencies.artifacts.resolveVersionDescriptors(args[0])
    })
    scope.registerGroup(dataContentApplicationCommandGroups[1], {
      'lifecycle:client-id': ({ callerContext }) => callerContext.lifecycleClientId
    })
    scope.registerGroup(dataContentApplicationCommandGroups[2], {
      'preview:delete': ({ args }) => dependencies.preview.delete(args[0]),
      'preview:load': ({ args }) => dependencies.preview.load(args[0]),
      'preview:save': ({ args }) => dependencies.preview.save(args[0])
    })
    scope.registerGroup(dataContentApplicationCommandGroups[3], {
      'preview-resources:acquire': ({ args, callerLease }) =>
        dependencies.managedPreview.acquire(callerLease, args[0]),
      'preview-resources:read-range': ({ args, callerLease }) =>
        dependencies.managedPreview.readRange(callerLease, args[0]),
      'preview-resources:release': ({ args, callerLease }) =>
        dependencies.managedPreview.release(callerLease, args[0])
    })
    scope.registerGroup(dataContentApplicationCommandGroups[4], {
      'project-files:get-overview': ({ args }) => dependencies.projectFiles.getOverview(args[0]),
      'project-files:list-artifact-groups': ({ args }) =>
        dependencies.projectFiles.listArtifactGroups(args[0]),
      'project-files:list-files': ({ args }) => dependencies.projectFiles.listFiles(args[0]),
      'project-files:repair-index': ({ args }) => dependencies.projectFiles.repairIndex(args[0]),
      'project-files:resolve-file': ({ args }) => dependencies.projectFiles.resolveFile(args[0]),
      'project-files:search-artifacts': ({ args }) =>
        dependencies.projectFiles.searchArtifacts(args[0])
    })
    scope.registerGroup(dataContentApplicationCommandGroups[5], {
      'projects:create': ({ args }) =>
        dependencies.withDataRootWrite(async () => {
          const project = await dependencies.projects.create(args[0])
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.projectCreated, project)
          return project
        }),
      'projects:delete': ({ args }) => dependencies.projects.delete(args[0].id),
      'projects:get': ({ args }) =>
        dependencies.withDataRootWrite(() => dependencies.projects.get(args[0])),
      'projects:list': () => dependencies.withDataRootWrite(() => dependencies.projects.list()),
      'projects:list-deletion-cleanup': () =>
        dependencies.withDataRootWrite(() => dependencies.projects.listDeletionCleanup()),
      'projects:retry-deletion-cleanup': () => dependencies.projects.retryDeletionCleanup(),
      'projects:update-archive': ({ args }) =>
        dependencies.withDataRootWrite(async () => {
          const project = await dependencies.projects.updateArchive(args[0])
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.projectUpdated, project)
          return project
        }),
      'projects:update': ({ args }) =>
        dependencies.withDataRootWrite(async () => {
          if (args[0].sessionDefaults !== undefined) {
            throw new Error(
              'Project Session defaults must be changed through the Task configuration API.'
            )
          }
          const project = await dependencies.projects.update(args[0])
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.projectUpdated, project)
          return project
        }),
      'projects:update-session-defaults': (invocation) => {
        assertTaskCaller(
          invocation,
          dataContentApplicationCommands.projectUpdateSessionDefaults.name
        )
        return dependencies.withDataRootWrite(async () => {
          if (invocation.args[0].sessionDefaults === undefined) {
            throw new Error('Project Session defaults are required.')
          }
          const project = await dependencies.projects.update(invocation.args[0])
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.projectUpdated, project)
          return project
        })
      }
    })
    scope.registerGroup(dataContentApplicationCommandGroups[6], {
      'sessions:delete-session': async ({ args }) => {
        const result = await dependencies.sessions.deleteSession(args[0])
        if (result.status === 'deleted') {
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.sessionDeleted, args[0])
        }
        return result
      },
      'sessions:edit-details': (invocation) => {
        return dependencies.withDataRootWrite(async () => {
          try {
            return await dependencies.sessions.editDetails(invocation.args[0])
          } catch (error) {
            if (SessionPersistence.isSessionDetailsConflictError(error)) {
              throw new ApplicationCommandError(
                SessionPersistence.SESSION_DETAILS_CONFLICT_ERROR_CODE,
                error instanceof Error ? error.message : 'Session details changed elsewhere.'
              )
            }
            if (SessionPersistence.isSessionRevisionConflictError(error)) {
              throw new ApplicationCommandError(
                SessionPersistence.SESSION_REVISION_CONFLICT_ERROR_CODE,
                error instanceof Error ? error.message : 'Session revision conflict.'
              )
            }
            throw error
          }
        })
      },
      'sessions:export-conversation': (invocation) => {
        assertElectronCaller(
          invocation,
          dataContentApplicationCommands.sessionExportConversation.name
        )
        return dependencies.electron.exportConversationFromInvokingWindow(invocation)
      },
      'sessions:filter-pdf-context-candidates': ({ args }) =>
        dependencies.withDataRootWrite(() =>
          dependencies.sessions.filterPdfContextCandidates(args[0])
        ),
      'sessions:load-all': () =>
        dependencies.withDataRootWrite(() => dependencies.sessions.loadAll()),
      'sessions:list': () => dependencies.withDataRootWrite(() => dependencies.sessions.list()),
      'sessions:link-pdf-context': (invocation) =>
        dependencies.withDataRootWrite(async () => {
          try {
            return await dependencies.sessions.linkPdfContext(invocation.args[0])
          } catch (error) {
            if (SessionPersistence.isSessionRevisionConflictError(error)) {
              throw new ApplicationCommandError(
                SessionPersistence.SESSION_REVISION_CONFLICT_ERROR_CODE,
                error instanceof Error ? error.message : 'Session revision conflict.'
              )
            }
            throw error
          }
        }),
      'sessions:load-one': ({ args }) =>
        dependencies.withDataRootWrite(() => dependencies.sessions.loadOne(args[0])),
      'sessions:load-usage': () =>
        dependencies.withDataRootWrite(() => dependencies.sessions.loadUsage()),
      'sessions:save-manifest': ({ args }) =>
        dependencies.withDataRootWrite(() => dependencies.sessions.saveManifest(args[0])),
      'sessions:update-archive': (invocation) => {
        const originClientId = invocation.callerContext.lifecycleClientId
        return dependencies.withDataRootWrite(async () => {
          const session = await dependencies.sessions.updateArchive(invocation.args[0])
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.sessionUpdated, {
            session,
            originClientId
          })
          return session
        })
      },
      'sessions:unlink-pdf-context': (invocation) =>
        dependencies.withDataRootWrite(async () => {
          try {
            return await dependencies.sessions.unlinkPdfContext(invocation.args[0])
          } catch (error) {
            if (SessionPersistence.isSessionRevisionConflictError(error)) {
              throw new ApplicationCommandError(
                SessionPersistence.SESSION_REVISION_CONFLICT_ERROR_CODE,
                error instanceof Error ? error.message : 'Session revision conflict.'
              )
            }
            throw error
          }
        }),
      'sessions:save-session': (invocation) => {
        const originClientId = invocation.callerContext.lifecycleClientId
        return dependencies.withDataRootWrite(async () => {
          let result: Awaited<ReturnType<SessionPersistenceHandlers['saveSession']>>
          try {
            result =
              invocation.callerContext.surface === 'task'
                ? await dependencies.sessions.saveSession(invocation.args[0], invocation.args[1], {
                    taskRunCommit: true
                  })
                : await dependencies.sessions.saveSession(invocation.args[0], invocation.args[1])
          } catch (error) {
            if (SessionPersistence.isSessionRevisionConflictError(error)) {
              throw new ApplicationCommandError(
                SessionPersistence.SESSION_REVISION_CONFLICT_ERROR_CODE,
                error instanceof Error ? error.message : 'Session revision conflict.'
              )
            }
            throw error
          }
          publishLifecycle(
            dependencies.events,
            result.created ? LIFECYCLE_CHANNELS.sessionCreated : LIFECYCLE_CHANNELS.sessionUpdated,
            { session: result.session, originClientId }
          )
          return result.session
        })
      },
      'sessions:stage-task-completion': (invocation) => {
        const originClientId = invocation.callerContext.lifecycleClientId
        return dependencies.withDataRootWrite(async () => {
          const session = await dependencies.sessions.stageTaskCompletion(invocation.args[0])
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.sessionUpdated, {
            session,
            originClientId
          })
          return session
        })
      },
      'sessions:settle-task-completion': (invocation) => {
        const originClientId = invocation.callerContext.lifecycleClientId
        return dependencies.withDataRootWrite(async () => {
          const session = await dependencies.sessions.settleTaskCompletion(invocation.args[0])
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.sessionUpdated, {
            session,
            originClientId
          })
          return session
        })
      },
      'sessions:fail-task-run': (invocation) => {
        const originClientId = invocation.callerContext.lifecycleClientId
        return dependencies.withDataRootWrite(async () => {
          const session = await dependencies.sessions.failTaskRun(invocation.args[0])
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.sessionUpdated, {
            session,
            originClientId
          })
          return session
        })
      },
      'sessions:set-delegation-policy': (invocation) => {
        assertSessionDelegationPolicyCaller(
          invocation,
          dataContentApplicationCommands.sessionSetDelegationPolicy.name
        )
        return dependencies.withDataRootWrite(async () => {
          const session = await dependencies.sessions.setDelegationPolicy(
            invocation.args[0],
            invocation.args[1],
            invocation.args[2]
          )
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.sessionUpdated, {
            session,
            originClientId: MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID
          })
          return session
        })
      },
      'sessions:update-configuration': (invocation) => {
        assertTaskCaller(invocation, dataContentApplicationCommands.sessionUpdateConfiguration.name)
        const originClientId = invocation.callerContext.lifecycleClientId
        return dependencies.withDataRootWrite(async () => {
          let session: SessionPersistence.PersistedChatSession
          try {
            session = await dependencies.sessions.updateSessionConfiguration(
              invocation.args[0],
              invocation.args[1]
            )
          } catch (error) {
            if (SessionPersistence.isSessionRevisionConflictError(error)) {
              throw new ApplicationCommandError(
                SessionPersistence.SESSION_REVISION_CONFLICT_ERROR_CODE,
                error instanceof Error ? error.message : 'Session revision conflict.'
              )
            }
            throw error
          }
          publishLifecycle(dependencies.events, LIFECYCLE_CHANNELS.sessionUpdated, {
            session,
            originClientId
          })
          return session
        })
      }
    })
    scope.registerGroup(dataContentApplicationCommandGroups[7], {
      'uploads:abort-transfer': (invocation) => dependencies.uploads.abortTransfer(invocation),
      'uploads:append-transfer': (invocation) => dependencies.uploads.appendTransfer(invocation),
      'uploads:begin-transfer': (invocation) => dependencies.uploads.beginTransfer(invocation),
      'uploads:claim-local-file': (invocation) => dependencies.uploads.claimLocalFile(invocation),
      'uploads:delete': (invocation) => dependencies.uploads.deleteUpload(invocation),
      'uploads:finalize-session': (invocation) => dependencies.uploads.finalizeSession(invocation),
      'uploads:finish-transfer': (invocation) => dependencies.uploads.finishTransfer(invocation),
      'uploads:read-preview': (invocation) => dependencies.uploads.readPreview(invocation),
      'uploads:stage-local-file': (invocation) => {
        assertElectronCaller(invocation, dataContentApplicationCommands.uploadStageLocalFile.name)
        return dependencies.electron.stageLocalFileWithProgress(invocation)
      },
      'uploads:stage-local-path': async (invocation) => {
        assertLocalCaller(invocation, dataContentApplicationCommands.uploadStageLocalPath.name)
        const attachment = await dependencies.uploads.stageLocalPath(invocation)
        dependencies.events.publish('project-files:changed', {
          projectId: invocation.args[0].projectId ?? Uploads.DEFAULT_UPLOAD_PROJECT_ID,
          sessionId: Uploads.STANDALONE_UPLOAD_SESSION_ID,
          sources: ['upload'],
          kind: 'upsert'
        })
        return attachment
      },
      'uploads:transfer-status': (invocation) => dependencies.uploads.transferStatus(invocation)
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  dataContentApplicationCommandGroups,
  dataContentApplicationCommands,
  registerDataContentApplicationCommands
}
export type { DataContentApplicationCommandDependencies }
