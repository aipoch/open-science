import type { ProvenanceReadResult } from './provenance-read-result'
import type {
  AcpCancelPromptRequest,
  AcpAgentRuntimeUpdate,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpContinueInterruptedTurnRequest,
  AcpCreateSessionResponse,
  AcpRuntimeEvent,
  AcpDeleteSessionRequest,
  AcpPermissionRequest,
  AcpPermissionResponse,
  ElicitationResponse,
  AcpPromptRequest,
  AcpSteerFollowUpRequest,
  AcpSteerFollowUpResult,
  AcpResumeSessionRequest,
  AcpSaveAsSkillRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateCommandResponse,
  AcpStateSnapshot,
  AcpStateUpdate
} from './acp'
import type { ActivePlanProjection, PlanResponseCommand } from './session-plan/contract'
import type {
  SideChatCloseRequest,
  SideChatPromptRequest,
  SideChatRelayDeliveredEvent,
  SideChatRuntimeEvent,
  SideChatSessionRequest,
  SideChatSnapshotList,
  SideChatStartRequest,
  SideChatStartResponse
} from './side-chat'
import type { SourcePreviewLoadState } from './source-preview'
import type {
  ArtifactPreviewResult,
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest,
  ReconcilePendingArtifactsResult,
  ResolveArtifactVersionDescriptorsRequest
} from './artifacts'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  ArtifactVersionExecutionProvenance,
  ArtifactVersionMessagesProvenance,
  ArtifactVersionProvenance,
  ArtifactVersionReviewProvenance,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest
} from './artifact-provenance'
import type {
  ArtifactCodeReconstructionState,
  GenerateArtifactCodeReconstructionRequest,
  GetArtifactCodeReconstructionRequest
} from './artifact-code-reconstruction'
import type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveProjectArtifactsRequest,
  SaveProjectArtifactsResult,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
} from './file-save'
import type {
  ManagedFileVersionCancelDiffRequest,
  ManagedFileVersionDiffRequest,
  ManagedFileVersionDiffResult,
  ManagedFileVersionInspectRequest,
  ManagedFileVersionInspectResult,
  ManagedFileVersionIpcResult,
  ManagedFileVersionSaveTextEditRequest,
  SaveTextEditResult
} from './managed-file-versions'
import type {
  ContributionTemplateExportResult,
  SpecialistPackageReportSaveResult,
  SpecialistExportPreview,
  SpecialistExportRequest,
  SpecialistExportSaveResult
} from './specialist-package'
import type {
  CancelComputeJobRequest,
  ComputeApprovalDecision,
  ComputeApprovalRequest,
  ComputeJobsListFilter,
  ComputeJobsPendingNotificationFilter,
  ComputeJobAnalysisTransition,
  ComputeHost,
  ComputeHostDeletionStatus,
  ComputePasswordCapability,
  CreateComputeHostRequest,
  CreatePasswordComputeHostRequest,
  CreatePasswordComputeHostResult,
  ResetPasswordComputeHostRequest,
  ResetPasswordComputeHostResult,
  SetComputeJobRemoteCleanupRequest,
  ChangeComputeHostAuthenticationRequest,
  ChangeComputeHostAuthenticationResult,
  DeleteComputeHostRequest,
  DetailsAuthor,
  JobSummary,
  JobStatusResult,
  ProbeResult
} from './compute'
import type { DirListing, DownloadDest, LocalFile } from './remote-fs'
import type {
  GrantLocalRootRequest,
  GrantedLocalRoot,
  LocalDirListing,
  LocalDrive,
  LocalRoots,
  RemoveGrantedLocalRootRequest,
  SetGrantedLocalRootAccessRequest
} from './local-fs'
import type { RendererFailureReport } from './diagnostics'
import type { LogFileStatus, OpenLogFileResult, RevealLogFileResult } from './logs'
import type {
  NotificationInboxChanged,
  NotificationInboxSnapshot,
  NotificationDesktopAvailability,
  NotificationMarkAllReadRequest,
  NotificationMarkReadRequest,
  NotificationMarkSessionCompletionsReadRequest,
  NotificationTestResult,
  OpenSessionFromNotificationRequest,
  UnreadTaskViewState
} from './notifications'
import type {
  ProjectDeletedEvent,
  SessionDeletedEvent,
  SessionUpsertEvent
} from './lifecycle-events'
import type {
  HandoffEventsRequest,
  HandoffLifecycleChange,
  HandoffLifecycleEvent,
  HandoffRetryRequest
} from './handoff-lifecycle'
import type {
  PermissionGrantDefaultsRestoreView,
  PermissionGrantMutationView,
  PermissionGrantRestoreRequest,
  PermissionGrantRevokeRequest,
  PermissionGrantSnapshot,
  PermissionGrantUndoExtendRequest,
  PermissionGrantUndoReceipt,
  PermissionGrantsChangedEvent
} from './permission-grants'
import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  NotebookAvailableEvent,
  NotebookChangedEvent,
  ExecuteNotebookCodeRequest,
  ExportNotebookAllRequest,
  ExportNotebookAllResult,
  ExportNotebookKernelRequest,
  ExportNotebookResult,
  FinishNotebookCodeCellRequest,
  NotebookLanguage,
  NotebookNamespaceRequest,
  NotebookNamespaceSnapshot,
  NotebookRestartRequest,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionStateRequest,
  NotebookSessionState,
  RunNotebookCellRequest
} from './notebook'
import type { ProvisionProgress, ProvisionStatus } from './notebook-env'
import type {
  DiscoveredInterpreter,
  EnvPackage,
  RuntimeEnablement,
  RuntimeUsage
} from './notebook-runtime'
import type {
  DeletePreviewStateRequest,
  LoadPreviewStateRequest,
  PreviewStateSnapshot,
  SavePreviewStateResult,
  SavePreviewStateRequest
} from './preview-state'
import type {
  OfficePreviewAttachResult,
  OfficePreviewOpenRequest,
  OfficePreviewOpenResult,
  OfficePreviewRuntimeState
} from './office-preview'
import type {
  AcquireManagedPreviewRequest,
  ManagedPreviewRangeResult,
  ManagedPreviewResource,
  ReadManagedPreviewRangeRequest,
  ReleaseManagedPreviewRequest
} from './preview-resources'
import {
  PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL,
  type PreviewContextMenuRequest
} from './preview-context-menu'
import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  Project,
  ProjectDeletionCleanup,
  ProjectDeletionOutcome,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from './projects'
import type {
  CreateTagRequest,
  DeleteTagRequest,
  ReorderTagsRequest,
  SetTagAssignmentRequest,
  TagSnapshot,
  TagsChangedEvent,
  UpdateTagRequest
} from './tags'
import type {
  CreateMemoryCategoryRequest,
  CreateMemoryEntryRequest,
  DeleteMemoryCategoryRequest,
  DeleteMemoryEntryRequest,
  MemoryChangedEvent,
  MemorySnapshot,
  SetMemoryEnabledRequest,
  UpdateMemoryCategoryRequest,
  UpdateMemoryEntryRequest
} from './memory'
import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFilesChangedEvent,
  ProjectFilesOverview,
  ProjectFilesPage,
  ResolveProjectFileRequest,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from './project-files'
import type {
  DeleteSessionRequest,
  DelegationPolicy,
  EditSessionDetailsRequest,
  FilterSessionPdfContextCandidatesRequest,
  FilterSessionPdfContextCandidatesResult,
  LinkSessionPdfContextRequest,
  SessionDeletionResult,
  LoadAllSessionsResult,
  ListSessionSummariesResult,
  LoadSessionRequest,
  OpenSessionRecoveryFolderRequest,
  PersistedChatSession,
  SaveSessionOptions,
  SaveSessionManifestRequest,
  SessionRuntimeContext,
  SessionUsageProjection,
  UnlinkSessionPdfContextRequest,
  UpdateSessionArchiveRequest
} from './session-persistence'
import type {
  SessionPersistenceFlushAbortedEvent,
  SessionPersistenceFlushRequest,
  SessionPersistenceFlushResponse
} from './session-persistence-flush'
import type { ExportConversationRequest, ExportConversationResult } from './conversation-export'
import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  DeleteProviderRequest,
  EnvironmentCheckResult,
  XaiOAuthDeviceAuthorization,
  InstallClaudeRequest,
  InstallCodeBuddyRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  SetActiveProviderRequest,
  SetPackageMirrorRequest,
  SetNetworkProxyRequest,
  SetNotebookNetworkRequest,
  SetAgentFrameworkRequest,
  SetConversationSkillImportEnabledRequest,
  SetNotificationsEnabledRequest,
  SetShowNotificationContentRequest,
  SetClosePreferenceRequest,
  SetProjectFilesFilterRequest,
  SetDefaultPermissionProfileRequest,
  SetAppIconVariantRequest,
  SetReasoningEffortRequest,
  SetReviewerModelRequest,
  SetSessionDetailsModelRequest,
  SetSubagentModelRequest,
  SetVisionModelRequest,
  SetSkillEnabledRequest,
  SetSkillsEnabledRequest,
  SettingsSnapshot,
  AppIconPreview,
  SkillDetailView,
  SkillView,
  CreateSkillRequest,
  UpdateSkillRequest,
  DeleteSkillRequest,
  ExportSkillRequest,
  ExportSkillResult,
  ImportSkillRequest,
  GitHubTokenStatus,
  SaveGitHubTokenRequest,
  ImportSkillResult,
  ImportSkillZipRequest,
  ImportSkillZipBatchRequest,
  ImportSkillZipBatchResult,
  ImportAgentHomeSkillsRequest,
  ImportAgentHomeSkillsResult,
  AgentHomeSkillView,
  PreviewAgentHomeSkillRequest,
  PreviewGitHubSkillRequest,
  PreviewSkillZipRequest,
  ResolveSkillDocumentRequest,
  ResolvedSkillDocument,
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  ScanRepoRequest,
  ScanRepoResult,
  ConnectorsSnapshot,
  DeviceCredentialsSnapshot,
  ConnectorDetailView,
  ConnectorTemplateExportPreview,
  ConnectorTemplateSelectionResult,
  SelectCustomServerTemplateRequest,
  ExportCustomServerTemplateRequest,
  ExportCustomServerTemplateResult,
  SetConnectorEnabledRequest,
  SetConnectorAutoAllowRequest,
  SetToolPermissionRequest,
  SetNcbiCredentialsRequest,
  SetOpenAlexCredentialRequest,
  ValidateOpenAlexCredentialRequest,
  OpenAlexCredentialValidation,
  AddCustomServerRequest,
  CreateDeviceCredentialRequest,
  CreateDeviceCredentialResult,
  DeviceCredentialAuthenticationRequest,
  AuthenticateCustomServerRequest,
  DisconnectCustomServerRequest,
  SetCustomServerEnabledRequest,
  RemoveCustomServerRequest,
  RemoveDeviceCredentialRequest,
  UpdateCustomServerRequest,
  UpdateDeviceCredentialRequest,
  ConnectorApprovalRequest,
  ConnectorCredentialRequest,
  ConversationSkillImportApprovalRequest,
  ConversationSkillImportApprovalResponse,
  RespondApprovalRequest,
  RespondConnectorCredentialRequest,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from './settings'
import type { PackageMirror } from './mirror'
import type { NetworkProxySettings } from './network-proxy'
import type { NotebookNetworkSettings, NotebookNetworkStatus } from './notebook-network'
import { NETWORK_SYSTEM_RESUMED_CHANNEL, type NetworkInfo } from './network'
import type {
  ActiveSessionInfo,
  DataRootInspection,
  DataRootValidationResult,
  DiscardMigratedCopyResult,
  MigrationOutcome,
  MigrationProgress,
  RevealAppStorageResult,
  StorageInfo,
  StorageStatus
} from './storage'
import type { CliLauncherStatus } from './cli'
import type { AppInfo, DownloadProgress, UpdateStatus } from './update'
import type {
  AppendUploadTransferRequest,
  BeginUploadTransferRequest,
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageLocalPathUploadRequest,
  UploadTransferProgress,
  UploadTransferRequest,
  UploadTransferStatus,
  UploadedAttachment
} from './uploads'
import type {
  ReviewWithChecks,
  ReviewRunRequest,
  ReviewRunResult,
  ReviewSessionRequest,
  ReviewSuppressionEvent,
  ReviewUpdateEvent
} from './reviewer'
import type {
  ApproveRemotePairingRequest,
  RemoteAccessSnapshot,
  RemotePairingRequestId,
  RevokeRemoteBrowserRequest,
  SetRemoteAccessModeRequest
} from './remote-access'
import type {
  CreateSpecialistRequest,
  UpdateSpecialistRequest,
  SetSpecialistEnabledRequest,
  DuplicateSpecialistRequest,
  SpecialistCatalogSnapshot,
  SpecialistView,
  SetSessionSpecialistRequest,
  SetSessionSpecialistResponse,
  ResolveSessionSpecialistRequest,
  SessionSpecialistResolution,
  PendingSwitchBroadcast,
  CompletionHandoffLifecycleEvent,
  CompletionHandoffCommand
} from './specialist'
import type {
  SpecialistPackageCandidatePreview,
  SpecialistPackageInstallRequest,
  SpecialistPackageInstallResult,
  SpecialistDeletePreview,
  SpecialistDeleteRequest,
  SpecialistDeleteResult
} from './specialist-package'
import type {
  AddMarketplaceSourceRequest,
  CancelMarketplaceCandidateRequest,
  GetMarketplaceReleaseRequest,
  InspectGitHubMarketplaceSourceRequest,
  ListMarketplaceRequest,
  MarketplaceDownloadProgress,
  MarketplaceInstallPreview,
  MarketplaceInstallRequest,
  MarketplaceInstallResult,
  MarketplaceSnapshot,
  MarketplaceSourceCandidate,
  MarketplaceSourceView,
  MarketplaceSpecialistRelease,
  PrepareMarketplaceInstallRequest,
  RemoveMarketplaceSourceRequest
} from './specialist-marketplace'
import type {
  CloseConfirmRequest,
  CloseConfirmResponse,
  WindowFindAppearance,
  WindowFindRequest,
  WindowFindResult
} from './window-controls'
import type { DatabaseStartupState } from './database-startup'
import type {
  InitializeLocalePreferenceRequest,
  LocalePreferenceSnapshot,
  SetLocalePreferenceRequest
} from './locale'

type RemoveListener = () => void
type AcpListener<Payload> = (payload: Payload) => void

import {
  defineRendererContractGroup,
  type RendererContractGroup,
  type RendererContractSeed,
  type RendererParameterCodec,
  type RendererSurfaceProfile
} from './renderer-contract'
import { DATABASE_STARTUP_CHANNELS } from './database-startup'
import { SOURCE_PREVIEW_LOAD_STATE_CHANNEL, SOURCE_PREVIEW_RELEASE_CHANNEL } from './source-preview'

const WEB = 'web'
const LOCAL = 'local'
const EVENT = 'event'
const CLOSE_PANE_EVENT = 'close-pane-event'
const ELECTRON = 'electron'
const MAPPED_ELECTRON = 'mapped-electron'
const SEND = 'send'
const WINDOW_FIND_READY = 'window-find-ready'
const ELECTRON_EVENT = 'electron-event'
const NATIVE = 'native'
const MAPPED_NATIVE = 'mapped-native'
const DELEGATED_NATIVE = 'delegated-native'

const POSITIONAL = 'positional'
const DEFAULT_EMPTY = 'default-empty-object'
const DEFAULT_EMPTY_ABSENT_ONLY = 'default-empty-object-absent-only'
const OPTIONAL_ARGUMENT_SLOT = 'optional-argument-slot'
const STORAGE_PARENT = 'storage-parent-object'
const STORAGE_ROOT = 'storage-data-root-object'
const RUNTIME_LANGUAGE_ENV = 'runtime-language-environment-object'
const RUNTIME_LANGUAGE = 'runtime-language-object'
const RUNTIME_ENABLEMENT = 'runtime-enablement-object'
const RUNTIME_INSTALL_AUTH = 'runtime-install-authorization-object'
const RUNTIME_INTERPRETER = 'runtime-interpreter-path-object'
const NATIVE_FILE_UPLOAD = 'native-file-upload-request'
const SESSION_SAVE = 'session-save-optional-argument'
const SESSION_SAVE_JSON = 'session-save-json-undefined'
const RUNTIME_VALIDATED = 'runtime-validated'

// prettier-ignore
type ContractProfile = typeof WEB | typeof LOCAL | typeof EVENT | typeof CLOSE_PANE_EVENT | typeof ELECTRON | typeof MAPPED_ELECTRON | typeof SEND | typeof WINDOW_FIND_READY | typeof ELECTRON_EVENT | typeof NATIVE | typeof MAPPED_NATIVE | typeof DELEGATED_NATIVE

// [channel, surface profile?, Electron codec?, Web codec?, Application command?].
// prettier-ignore
type ContractMetadata = readonly [channel: string | null, profile?: ContractProfile, electronCodec?: RendererParameterCodec, webCodec?: RendererParameterCodec, applicationCommand?: typeof RUNTIME_VALIDATED]

type ContractOptions = Readonly<{ optionalRoot?: true; optionalMember?: true }>

type RendererApiContractDraft<
  Value,
  OptionalRoot extends boolean = false,
  OptionalMember extends boolean = false
> = Readonly<{
  capability: string
  metadata: ContractMetadata | null
  optionalRoot: OptionalRoot
  optionalMember: OptionalMember
  __value?: Value
}>

const callable =
  <Value extends (...args: never[]) => unknown>() =>
  <const Options extends ContractOptions | undefined = undefined>(
    capability: string,
    metadata: ContractMetadata,
    options?: Options
  ): RendererApiContractDraft<
    Value,
    Options extends { optionalRoot: true } ? true : false,
    Options extends { optionalMember: true } ? true : false
  > =>
    Object.freeze({
      capability,
      metadata,
      optionalRoot: Boolean(options?.optionalRoot) as Options extends { optionalRoot: true }
        ? true
        : false,
      optionalMember: Boolean(options?.optionalMember) as Options extends { optionalMember: true }
        ? true
        : false
    })

const value =
  <Value>() =>
  (capability: string): RendererApiContractDraft<Value> =>
    Object.freeze({ capability, metadata: null, optionalRoot: false, optionalMember: false })

// prettier-ignore
const CLOSE_PANE_LIFECYCLE = { activateChannel: 'shortcut:close-active-pane-ready', activate: 'after-subscribe', deactivateChannel: 'shortcut:close-active-pane-unready', deactivate: 'after-unsubscribe' } as const
// prettier-ignore
const WINDOW_FIND_LIFECYCLE = { activateChannel: 'shortcut:window-find-ready', activate: 'on-call', deactivateChannel: 'shortcut:window-find-unready', deactivate: 'on-dispose' } as const

const surface = <Value>(
  electron: Value,
  localWeb: Value,
  remoteWeb: Value
): RendererSurfaceProfile<Value> => ({ electron, localWeb, remoteWeb })

const expandEntry = (
  publicPath: string,
  { capability, metadata }: RendererApiContractDraft<unknown, boolean, boolean>
): RendererContractSeed & { capability: string } => {
  if (metadata === null) {
    throw new Error('Renderer value has no transport descriptor: ' + publicPath)
  }
  const [channel, profile = WEB, electronCodec, webCodec, applicationCommand] = metadata
  const isWebRequest = profile === WEB || profile === LOCAL
  const isWebEvent = profile === EVENT
  const isElectronEvent = profile === ELECTRON_EVENT || profile === CLOSE_PANE_EVENT
  const isNative = profile === NATIVE || profile === MAPPED_NATIVE || profile === DELEGATED_NATIVE
  const kind = isWebEvent || isElectronEvent ? 'event' : 'method'
  const defaultElectronCodec =
    kind === 'event' ? 'event-listener' : profile === NATIVE ? 'surface-native' : POSITIONAL
  const defaultWebCodec = isNative ? 'surface-native' : defaultElectronCodec
  const localInstallation = isWebRequest
    ? 'web-rpc'
    : isWebEvent
      ? 'web-event'
      : isNative
        ? 'browser-native'
        : 'unavailable'
  const localDispatch = isWebRequest
    ? 'direct-application-request'
    : isWebEvent
      ? 'web-event-subscription'
      : profile === DELEGATED_NATIVE
        ? 'browser-native-with-direct-application-request'
        : isNative
          ? 'surface-native'
          : 'none'
  const electronDispatch =
    profile === SEND || profile === WINDOW_FIND_READY
      ? 'electron-ipc-send'
      : kind === 'event'
        ? 'electron-ipc-subscription'
        : profile === NATIVE
          ? 'surface-native'
          : 'electron-ipc-request'

  return {
    capability,
    publicPath,
    channel,
    kind,
    parameterCodec: {
      electron: electronCodec ?? defaultElectronCodec,
      web: webCodec ?? electronCodec ?? defaultWebCodec
    },
    surfaceInstallation: surface(
      'preload',
      localInstallation,
      profile === LOCAL ? 'rejecting-stub' : localInstallation
    ),
    dispatchPolicy: surface(
      electronDispatch,
      localDispatch,
      profile === LOCAL ? 'rejecting-stub' : localDispatch
    ),
    eventDeliverability: surface(
      kind === 'event' ? 'electron-ipc' : 'not-event',
      profile === EVENT ? 'application-event' : kind === 'event' ? 'unavailable' : 'not-event',
      profile === EVENT ? 'application-event' : kind === 'event' ? 'unavailable' : 'not-event'
    ),
    authorityFlow: surface(
      kind === 'event' || profile === NATIVE ? 'none' : 'electron-sender',
      isWebRequest || profile === DELEGATED_NATIVE ? 'caller-context' : 'none',
      profile === WEB || profile === DELEGATED_NATIVE ? 'caller-context' : 'none'
    ),
    applicationCommand,
    lifecycleDispatch:
      profile === CLOSE_PANE_EVENT
        ? CLOSE_PANE_LIFECYCLE
        : profile === WINDOW_FIND_READY
          ? WINDOW_FIND_LIFECYCLE
          : undefined,
    mapProjection:
      isWebRequest ||
      profile === MAPPED_ELECTRON ||
      profile === MAPPED_NATIVE ||
      profile === DELEGATED_NATIVE
        ? 'invoke'
        : isWebEvent
          ? 'event'
          : 'none'
  }
}

type BivariantCallable<Value> = Value extends (...args: infer Args) => infer Result
  ? { bivarianceHack(...args: Args): Result }['bivarianceHack']
  : Value
type ContractValue<Draft> =
  Draft extends RendererApiContractDraft<infer Value, boolean, boolean>
    ? BivariantCallable<Value>
    : never
type ContractOptionalRoot<Draft> =
  Draft extends RendererApiContractDraft<unknown, infer Optional, boolean> ? Optional : false
type ContractOptionalMember<Draft> =
  Draft extends RendererApiContractDraft<unknown, boolean, infer Optional> ? Optional : false

type PathObject<
  Path extends string,
  Value,
  OptionalRoot extends boolean,
  OptionalMember extends boolean
> = Path extends `${infer Root}.${infer Rest}`
  ? OptionalRoot extends true
    ? { [Key in Root]?: PathObject<Rest, Value, false, OptionalMember> }
    : { [Key in Root]: PathObject<Rest, Value, false, OptionalMember> }
  : OptionalMember extends true
    ? { [Key in Path]?: Value }
    : { [Key in Path]: Value }

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection
) => void
  ? Intersection
  : never

export type RendererApiFromContract<
  Contract extends Readonly<Record<string, RendererApiContractDraft<unknown, boolean, boolean>>>
> = {
  [
    Key in keyof UnionToIntersection<
      {
        [Path in keyof Contract & string]: PathObject<
          Path,
          ContractValue<Contract[Path]>,
          ContractOptionalRoot<Contract[Path]>,
          ContractOptionalMember<Contract[Path]>
        >
      }[keyof Contract & string]
    >
  ]: UnionToIntersection<
    {
      [Path in keyof Contract & string]: PathObject<
        Path,
        ContractValue<Contract[Path]>,
        ContractOptionalRoot<Contract[Path]>,
        ContractOptionalMember<Contract[Path]>
      >
    }[keyof Contract & string]
  >[Key]
}

export const RENDERER_API_CONTRACT = Object.freeze({
  'acp.cancel': callable<(request: AcpCancelPromptRequest) => Promise<AcpStateCommandResponse>>()(
    'acp',
    ['acp:cancel']
  ),
  'acp.compactSession': callable<
    (request: AcpCompactSessionRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:compact-session']),
  'acp.connect': callable<(request?: AcpConnectRequest) => Promise<AcpStateCommandResponse>>()(
    'acp',
    ['acp:connect', WEB, DEFAULT_EMPTY, DEFAULT_EMPTY_ABSENT_ONLY]
  ),
  'acp.continueInterruptedTurn': callable<
    (request: AcpContinueInterruptedTurnRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:continue-interrupted-turn']),
  'acp.createSession': callable<
    (request?: AcpCreateSessionRequest) => Promise<AcpCreateSessionResponse>
  >()('acp', ['acp:create-session', WEB, DEFAULT_EMPTY, DEFAULT_EMPTY_ABSENT_ONLY]),
  'acp.deleteSession': callable<
    (request: AcpDeleteSessionRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:delete-session']),
  'acp.disconnect': callable<() => Promise<AcpStateCommandResponse>>()('acp', ['acp:disconnect']),
  'acp.getPlanProjection': callable<
    (projectId: string, sessionId: string) => Promise<ActivePlanProjection | null>
  >()('acp', ['acp:get-plan-projection']),
  'acp.getState': callable<() => Promise<AcpStateSnapshot>>()('acp', ['acp:get-state']),
  'acp.onAgentRuntimeUpdate': callable<
    (listener: AcpListener<AcpAgentRuntimeUpdate>) => RemoveListener
  >()('acp', ['acp:agent-runtime-update', EVENT]),
  'acp.onEvent': callable<(listener: AcpListener<readonly AcpRuntimeEvent[]>) => RemoveListener>()(
    'acp',
    ['acp:event', EVENT]
  ),
  'acp.onPermissionRequest': callable<
    (listener: AcpListener<AcpPermissionRequest>) => RemoveListener
  >()('acp', ['acp:permission-request', EVENT]),
  'acp.onState': callable<(listener: AcpListener<AcpStateUpdate>) => RemoveListener>()('acp', [
    'acp:state',
    EVENT
  ]),
  'acp.resetSessionContext': callable<
    (request: AcpResumeSessionRequest) => Promise<AcpCreateSessionResponse>
  >()('acp', ['acp:reset-session-context']),
  'acp.respondPlan': callable<(request: PlanResponseCommand) => Promise<unknown>>()('acp', [
    'acp:respond-plan'
  ]),
  'acp.respondToElicitation': callable<
    (response: ElicitationResponse) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:respond-elicitation']),
  'acp.respondToPermission': callable<
    (response: AcpPermissionResponse) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:respond-permission']),
  'acp.resumeSession': callable<
    (request: AcpResumeSessionRequest) => Promise<AcpCreateSessionResponse>
  >()('acp', ['acp:resume-session']),
  'acp.revokePermissionGrant': callable<
    (request: AcpRevokePermissionGrantRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:revoke-permission-grant']),
  'acp.saveAsSkill': callable<
    (request: AcpSaveAsSkillRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:save-as-skill']),
  'acp.sendPrompt': callable<(request: AcpPromptRequest) => Promise<AcpStateCommandResponse>>()(
    'acp',
    ['acp:send-prompt']
  ),
  'acp.setPermissionProfile': callable<
    (request: AcpSetPermissionProfileRequest) => Promise<AcpStateCommandResponse>
  >()('acp', ['acp:set-permission-profile']),
  'acp.steerFollowUp': callable<
    (request: AcpSteerFollowUpRequest) => Promise<AcpSteerFollowUpResult>
  >()('acp', ['acp:steer-follow-up']),
  'artifacts.finalizeRunArtifacts': callable<
    (request: FinalizeRunArtifactsRequest) => Promise<FinalizeRunArtifactsResult>
  >()('artifacts', ['artifacts:finalize-run']),
  'artifacts.generateCodeReconstruction': callable<
    (request: GenerateArtifactCodeReconstructionRequest) => Promise<ArtifactCodeReconstructionState>
  >()('artifacts', ['artifacts:generate-code-reconstruction']),
  'artifacts.getCodeReconstruction': callable<
    (request: GetArtifactCodeReconstructionRequest) => Promise<ArtifactCodeReconstructionState>
  >()('artifacts', ['artifacts:get-code-reconstruction']),
  'artifacts.getLineage': callable<
    (
      request: GetArtifactLineageRequest
    ) => Promise<ProvenanceReadResult<ArtifactLineageProvenance | undefined>>
  >()('artifacts', ['artifacts:get-lineage']),
  'artifacts.getVersionExecution': callable<
    (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ProvenanceReadResult<ArtifactVersionExecutionProvenance>>
  >()('artifacts', ['artifacts:get-version-execution']),
  'artifacts.getVersionMessages': callable<
    (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ProvenanceReadResult<ArtifactVersionMessagesProvenance>>
  >()('artifacts', ['artifacts:get-version-messages']),
  'artifacts.getVersionProvenance': callable<
    (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ProvenanceReadResult<ArtifactVersionProvenance>>
  >()('artifacts', ['artifacts:get-version-provenance']),
  'artifacts.getVersionReview': callable<
    (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ProvenanceReadResult<ArtifactVersionReviewProvenance>>
  >()('artifacts', ['artifacts:get-version-review']),
  'artifacts.openFile': callable<(request: OpenArtifactFileRequest) => Promise<void>>()(
    'artifacts',
    ['artifacts:open-file', LOCAL]
  ),
  'artifacts.readPreview': callable<
    (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  >()('artifacts', ['artifacts:read-preview']),
  'artifacts.reconcilePendingArtifacts': callable<
    (request: ReconcilePendingArtifactsRequest) => Promise<ReconcilePendingArtifactsResult>
  >()('artifacts', ['artifacts:reconcile-pending']),
  'artifacts.resolveVersionDescriptors': callable<
    (request: ResolveArtifactVersionDescriptorsRequest) => Promise<ArtifactVersionDescriptor[]>
  >()('artifacts', ['artifacts:resolve-version-descriptors']),
  'cli.getStatus': callable<() => Promise<CliLauncherStatus>>()('cli', ['cli:get-status']),
  'cli.install': callable<() => Promise<CliLauncherStatus>>()('cli', ['cli:install', LOCAL]),
  'cli.uninstall': callable<() => Promise<CliLauncherStatus>>()('cli', ['cli:uninstall', LOCAL]),
  'compute.bookmarksGet': callable<(providerId: string) => Promise<string[]>>()('compute', [
    'compute:bookmarks:get'
  ]),
  'compute.bookmarksSet': callable<(providerId: string, folders: string[]) => Promise<void>>()(
    'compute',
    ['compute:bookmarks:set']
  ),
  'compute.changeAuthentication': callable<
    (
      request: ChangeComputeHostAuthenticationRequest
    ) => Promise<ChangeComputeHostAuthenticationResult>
  >()('compute', ['compute:change-authentication', LOCAL]),
  'compute.concurrencySet': callable<(providerId: string, limit: number) => Promise<void>>()(
    'compute',
    ['compute:concurrency:set']
  ),
  'compute.create': callable<(request: CreateComputeHostRequest) => Promise<ComputeHost>>()(
    'compute',
    ['compute:create']
  ),
  'compute.createPassword': callable<
    (request: CreatePasswordComputeHostRequest) => Promise<CreatePasswordComputeHostResult>
  >()('compute', ['compute:create-password', LOCAL]),
  'compute.delete': callable<(request: DeleteComputeHostRequest) => Promise<void>>()('compute', [
    'compute:delete'
  ]),
  'compute.deletionStatus': callable<
    (request: DeleteComputeHostRequest) => Promise<ComputeHostDeletionStatus>
  >()('compute', ['compute:deletion-status']),
  'compute.detailsGet': callable<
    (providerId: string) => Promise<{ doc: string; isSkeleton: boolean }>
  >()('compute', ['compute:details:get']),
  'compute.detailsSave': callable<
    (providerId: string, text: string, oldText: string, author: DetailsAuthor) => Promise<void>
  >()('compute', ['compute:details:save']),
  'compute.download': callable<
    (providerId: string, remotePath: string, dest: DownloadDest) => Promise<LocalFile>
  >()('compute', ['compute:download', LOCAL]),
  'compute.enabledHostsGet': callable<(sessionId: string) => Promise<string[]>>()('compute', [
    'compute:enabled-hosts:get'
  ]),
  'compute.enabledHostsSet': callable<
    (sessionId: string, providerIds: string[]) => Promise<PersistedChatSession>
  >()('compute', ['compute:enabled-hosts:set']),
  'compute.hostEnabledSet': callable<
    (sessionId: string, providerId: string, enabled: boolean) => Promise<PersistedChatSession>
  >()('compute', ['compute:host-enabled:set']),
  'compute.hostSelectedSet': callable<
    (sessionId: string, providerId: string, selected: boolean) => Promise<PersistedChatSession>
  >()('compute', ['compute:host-selected:set']),
  'compute.get': callable<(providerId: string) => Promise<ComputeHost | null>>()('compute', [
    'compute:get'
  ]),
  'compute.jobsList': callable<(filter: ComputeJobsListFilter) => Promise<JobSummary[]>>()(
    'compute',
    ['compute:jobs:list']
  ),
  'compute.jobsCancel': callable<(request: CancelComputeJobRequest) => Promise<JobStatusResult>>()(
    'compute',
    ['compute:jobs:cancel']
  ),
  'compute.jobsSetRemoteCleanup': callable<
    (request: SetComputeJobRemoteCleanupRequest) => Promise<void>
  >()('compute', ['compute:jobs:set-remote-cleanup', LOCAL]),
  'compute.jobsMarkConsumed': callable<(sessionId: string, jobIds: string[]) => Promise<void>>()(
    'compute',
    ['compute:jobs:mark-consumed']
  ),
  'compute.jobsPendingNotification': callable<
    (filter: ComputeJobsPendingNotificationFilter) => Promise<JobSummary[]>
  >()('compute', ['compute:jobs:pending-notification']),
  'compute.jobsTransitionAnalysis': callable<
    (request: ComputeJobAnalysisTransition) => Promise<JobSummary[]>
  >()('compute', ['compute:jobs:transition-analysis']),
  'compute.list': callable<() => Promise<ComputeHost[]>>()('compute', ['compute:list']),
  'compute.listDir': callable<(providerId: string, path: string) => Promise<DirListing>>()(
    'compute',
    ['compute:list-dir']
  ),
  'compute.onApprovalRequest': callable<
    (listener: (request: ComputeApprovalRequest) => void) => () => void
  >()('compute', ['compute:approval-request', EVENT]),
  'compute.onApprovalSettled': callable<(listener: (id: string) => void) => () => void>()(
    'compute',
    ['compute:approval-settled', EVENT],
    { optionalMember: true }
  ),
  'compute.onJobUpdated': callable<(listener: (job: JobSummary) => void) => () => void>()(
    'compute',
    ['compute:job-updated', EVENT]
  ),
  'compute.passwordCapability': callable<() => Promise<ComputePasswordCapability>>()('compute', [
    'compute:password-capability',
    LOCAL
  ]),
  'compute.probe': callable<(providerId: string) => Promise<ProbeResult>>()('compute', [
    'compute:probe'
  ]),
  'compute.replayApproval': callable<(id: string) => Promise<ComputeApprovalRequest | null>>()(
    'compute',
    ['compute:approval-replay']
  ),
  'compute.replayPendingApprovals': callable<() => Promise<void>>()(
    'compute',
    ['compute:approval-replay-pending'],
    { optionalMember: true }
  ),
  'compute.resetPassword': callable<
    (request: ResetPasswordComputeHostRequest) => Promise<ResetPasswordComputeHostResult>
  >()('compute', ['compute:reset-password', LOCAL]),
  'compute.respondApproval': callable<
    (request: { id: string; decision: ComputeApprovalDecision }) => Promise<void>
  >()('compute', ['compute:approval-respond']),
  'compute.revealInFolder': callable<(filePath: string) => Promise<void>>()('compute', [
    'compute:reveal-in-folder',
    LOCAL
  ]),
  'compute.scratchSet': callable<(providerId: string, path: string) => Promise<void>>()('compute', [
    'compute:scratch:set'
  ]),
  'compute.scratchClear': callable<(providerId: string) => Promise<void>>()('compute', [
    'compute:scratch:clear'
  ]),
  'compute.sshConfigAliases': callable<() => Promise<string[]>>()('compute', [
    'compute:ssh-config-aliases'
  ]),
  'databaseStartup.getState': callable<() => Promise<DatabaseStartupState>>()('database-startup', [
    DATABASE_STARTUP_CHANNELS.getState,
    ELECTRON
  ]),
  'databaseStartup.onStateChanged': callable<
    (listener: AcpListener<DatabaseStartupState>) => RemoveListener
  >()('database-startup', [DATABASE_STARTUP_CHANNELS.stateChanged, ELECTRON_EVENT]),
  'databaseStartup.quit': callable<() => Promise<void>>()('database-startup', [
    DATABASE_STARTUP_CHANNELS.quit,
    ELECTRON
  ]),
  'databaseStartup.retry': callable<() => Promise<DatabaseStartupState>>()('database-startup', [
    DATABASE_STARTUP_CHANNELS.retry,
    ELECTRON
  ]),
  'diagnostics.reportRendererFailure': callable<(report: RendererFailureReport) => void>()(
    'diagnostics',
    ['diagnostics:renderer-failure', SEND],
    { optionalRoot: true }
  ),
  getRuntimeVersions: callable<
    () => {
      electron: string
      chrome: string
      node: string
    }
  >()('platform-file-save', [null, NATIVE]),
  'github.getStars': callable<() => Promise<number | null>>()('github', ['github:get-stars']),
  'handoff.list': callable<
    (request: HandoffEventsRequest) => Promise<readonly HandoffLifecycleEvent[]>
  >()('handoff', ['handoff-lifecycle:list', ELECTRON]),
  'handoff.onChanged': callable<
    (listener: AcpListener<HandoffLifecycleChange>) => RemoveListener
  >()('handoff', ['handoff-lifecycle:changed', ELECTRON_EVENT]),
  'handoff.retry': callable<(request: HandoffRetryRequest) => Promise<void>>()('handoff', [
    'handoff-lifecycle:retry',
    ELECTRON
  ]),
  'lifecycle.getClientId': callable<() => Promise<string>>()('lifecycle', ['lifecycle:client-id']),
  'locale.initialize': callable<
    (request: InitializeLocalePreferenceRequest) => Promise<LocalePreferenceSnapshot>
  >()('locale', ['locale:initialize', ELECTRON]),
  'locale.onChanged': callable<
    (listener: AcpListener<LocalePreferenceSnapshot>) => RemoveListener
  >()('locale', ['locale:changed', ELECTRON_EVENT]),
  'locale.setPreference': callable<
    (request: SetLocalePreferenceRequest) => Promise<LocalePreferenceSnapshot>
  >()('locale', ['locale:set-preference', ELECTRON]),
  'localFs.getRoots': callable<() => Promise<LocalRoots>>()('local-fs', [
    'local-fs:get-roots',
    LOCAL
  ]),
  'localFs.grantRoot': callable<(request: GrantLocalRootRequest) => Promise<GrantedLocalRoot[]>>()(
    'local-fs',
    ['local-fs:grant-root', LOCAL]
  ),
  'localFs.listDir': callable<(path: string) => Promise<LocalDirListing>>()('local-fs', [
    'local-fs:list-dir',
    LOCAL
  ]),
  'localFs.listDrives': callable<() => Promise<LocalDrive[]>>()('local-fs', [
    'local-fs:list-drives',
    LOCAL
  ]),
  'localFs.listGrantedRoots': callable<() => Promise<GrantedLocalRoot[]>>()('local-fs', [
    'local-fs:granted-roots:list',
    LOCAL
  ]),
  'localFs.openPath': callable<(path: string) => Promise<string>>()('local-fs', [
    'local-fs:open-path',
    LOCAL
  ]),
  'localFs.readPreview': callable<
    (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  >()('local-fs', ['local-fs:read-preview', LOCAL]),
  'localFs.removeGrantedRoot': callable<
    (request: RemoveGrantedLocalRootRequest) => Promise<GrantedLocalRoot[]>
  >()('local-fs', ['local-fs:granted-roots:remove', LOCAL]),
  'localFs.reveal': callable<(path: string) => Promise<void>>()('local-fs', [
    'local-fs:reveal',
    LOCAL
  ]),
  'localFs.setGrantedRootAccess': callable<
    (request: SetGrantedLocalRootAccessRequest) => Promise<GrantedLocalRoot[]>
  >()('local-fs', ['local-fs:granted-roots:set-access', LOCAL]),
  'logs.getStatus': callable<() => Promise<LogFileStatus>>()('logs', ['logs:get-status', LOCAL]),
  'logs.openFile': callable<() => Promise<OpenLogFileResult>>()('logs', ['logs:open-file', LOCAL]),
  'logs.revealInFolder': callable<() => Promise<RevealLogFileResult>>()('logs', [
    'logs:reveal-in-folder',
    LOCAL
  ]),
  'managedFileVersions.cancelDiff': callable<
    (
      request: ManagedFileVersionCancelDiffRequest
    ) => Promise<ManagedFileVersionIpcResult<{ cancelled: boolean }>>
  >()('managed-file-versions', ['managed-file-versions:cancel-diff', ELECTRON]),
  'managedFileVersions.diffText': callable<
    (
      request: ManagedFileVersionDiffRequest
    ) => Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>
  >()('managed-file-versions', ['managed-file-versions:diff-text', ELECTRON]),
  'managedFileVersions.inspect': callable<
    (
      request: ManagedFileVersionInspectRequest
    ) => Promise<ManagedFileVersionIpcResult<ManagedFileVersionInspectResult>>
  >()('managed-file-versions', ['managed-file-versions:inspect', ELECTRON]),
  'managedFileVersions.saveTextEdit': callable<
    (
      request: ManagedFileVersionSaveTextEditRequest
    ) => Promise<ManagedFileVersionIpcResult<SaveTextEditResult>>
  >()('managed-file-versions', ['managed-file-versions:save-text-edit', ELECTRON]),
  'memory.clearAll': callable<() => Promise<MemorySnapshot>>()('memory', [
    'memory:clear-all',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'memory.createCategory': callable<
    (request: CreateMemoryCategoryRequest) => Promise<MemorySnapshot>
  >()('memory', ['memory:create-category', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'memory.createEntry': callable<(request: CreateMemoryEntryRequest) => Promise<MemorySnapshot>>()(
    'memory',
    ['memory:create-entry', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'memory.deleteCategory': callable<
    (request: DeleteMemoryCategoryRequest) => Promise<MemorySnapshot>
  >()('memory', ['memory:delete-category', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'memory.deleteEntry': callable<(request: DeleteMemoryEntryRequest) => Promise<MemorySnapshot>>()(
    'memory',
    ['memory:delete-entry', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'memory.onChanged': callable<(listener: AcpListener<MemoryChangedEvent>) => RemoveListener>()(
    'memory',
    ['memory:changed', EVENT]
  ),
  'memory.setEnabled': callable<(request: SetMemoryEnabledRequest) => Promise<MemorySnapshot>>()(
    'memory',
    ['memory:set-enabled', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'memory.snapshot': callable<() => Promise<MemorySnapshot>>()('memory', [
    'memory:snapshot',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'memory.updateCategory': callable<
    (request: UpdateMemoryCategoryRequest) => Promise<MemorySnapshot>
  >()('memory', ['memory:update-category', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'memory.updateEntry': callable<(request: UpdateMemoryEntryRequest) => Promise<MemorySnapshot>>()(
    'memory',
    ['memory:update-entry', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'network.checkConnectivity': callable<() => Promise<boolean>>()('network', [
    'network:check-connectivity',
    ELECTRON
  ]),
  'network.getInfo': callable<() => Promise<NetworkInfo>>()('network', [
    'network:get-info',
    ELECTRON
  ]),
  'network.onSystemResume': callable<(listener: () => void) => RemoveListener>()('network', [
    NETWORK_SYSTEM_RESUMED_CHANNEL,
    ELECTRON_EVENT
  ]),
  'notebook.appendCodeCell': callable<
    (request: AppendNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      writeId: string
      receivedBytes: number
    }>
  >()('notebook', ['notebook:append-code-cell']),
  'notebook.beginCodeCell': callable<
    (request: BeginNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      writeId: string
      status: string
    }>
  >()('notebook', ['notebook:begin-code-cell']),
  'notebook.execute': callable<
    (request: ExecuteNotebookCodeRequest) => Promise<NotebookRunSummary>
  >()('notebook', ['notebook:execute']),
  'notebook.exportIpynb': callable<
    (request: ExportNotebookKernelRequest) => Promise<ExportNotebookResult>
  >()('notebook', ['notebook:export-ipynb', LOCAL]),
  'notebook.exportIpynbAll': callable<
    (request: ExportNotebookAllRequest) => Promise<ExportNotebookAllResult>
  >()('notebook', ['notebook:export-ipynb-all', LOCAL]),
  'notebook.finishCodeCell': callable<
    (request: FinishNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      code: string
      status: string
    }>
  >()('notebook', ['notebook:finish-code-cell']),
  'notebook.getReference': callable<
    (request: NotebookSessionRequest) => Promise<NotebookSessionReference | null>
  >()('notebook', ['notebook:reference']),
  'notebook.inspectNamespace': callable<
    (request: NotebookNamespaceRequest) => Promise<NotebookNamespaceSnapshot>
  >()('notebook', ['notebook:inspect-namespace']),
  'notebook.onAvailable': callable<
    (listener: AcpListener<NotebookAvailableEvent>) => RemoveListener
  >()('notebook', ['notebook:available', EVENT]),
  'notebook.onChanged': callable<(listener: AcpListener<NotebookChangedEvent>) => RemoveListener>()(
    'notebook',
    ['notebook:changed', EVENT]
  ),
  'notebook.readInputPreview': callable<
    (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  >()('notebook', ['notebook:read-input-preview']),
  'notebook.restart': callable<
    (request: NotebookRestartRequest) => Promise<NotebookSessionState>
  >()('notebook', ['notebook:restart']),
  'notebook.runCell': callable<(request: RunNotebookCellRequest) => Promise<NotebookRunSummary>>()(
    'notebook',
    ['notebook:run-cell']
  ),
  'notebook.shutdown': callable<
    (request: NotebookSessionRequest) => Promise<{ sessionId: string; status: 'shutdown' }>
  >()('notebook', ['notebook:shutdown']),
  'notebook.state': callable<
    (request: NotebookSessionStateRequest) => Promise<NotebookSessionState>
  >()('notebook', ['notebook:state']),
  'notebookEnv.cancel': callable<(lang?: NotebookLanguage) => Promise<void>>()(
    'notebook-environment',
    ['notebook-env:cancel', LOCAL, OPTIONAL_ARGUMENT_SLOT, POSITIONAL]
  ),
  'notebookEnv.getStatus': callable<() => Promise<ProvisionStatus>>()('notebook-environment', [
    'notebook-env:status'
  ]),
  'notebookEnv.onProgress': callable<
    (listener: (progress: ProvisionProgress) => void) => RemoveListener
  >()('notebook-environment', ['notebook-env:progress', EVENT]),
  'notebookEnv.provision': callable<
    (lang: NotebookLanguage, operationId?: string) => Promise<void>
  >()('notebook-environment', ['notebook-env:provision', LOCAL]),
  'notebookEnv.repair': callable<
    (lang: NotebookLanguage, runtimeIdentity: string, operationId?: string) => Promise<void>
  >()('notebook-environment', ['notebook-env:repair', LOCAL]),
  'notifications.getSnapshot': callable<() => Promise<NotificationInboxSnapshot>>()(
    'notifications',
    ['notifications:get-snapshot']
  ),
  'notifications.getDesktopAvailability': callable<
    () => Promise<NotificationDesktopAvailability>
  >()('notifications', ['notifications:get-desktop-availability', ELECTRON], {
    optionalMember: true
  }),
  'notifications.markAllRead': callable<
    (request: NotificationMarkAllReadRequest) => Promise<void>
  >()('notifications', ['notifications:mark-all-read']),
  'notifications.markRead': callable<(request: NotificationMarkReadRequest) => Promise<void>>()(
    'notifications',
    ['notifications:mark-read']
  ),
  'notifications.markSessionCompletionsRead': callable<
    (request: NotificationMarkSessionCompletionsReadRequest) => Promise<void>
  >()('notifications', ['notifications:mark-session-completions-read']),
  'notifications.sendTest': callable<() => Promise<NotificationTestResult>>()(
    'notifications',
    ['notifications:send-test', ELECTRON],
    { optionalMember: true }
  ),
  'notifications.onChanged': callable<
    (listener: AcpListener<NotificationInboxChanged>) => RemoveListener
  >()('notifications', ['notifications:changed', EVENT]),
  'notifications.onOpenSession': callable<(listener: () => void) => RemoveListener>()(
    'notifications',
    ['notifications:open-session', ELECTRON_EVENT],
    { optionalMember: true }
  ),
  'notifications.onViewProbe': callable<(listener: AcpListener<number>) => RemoveListener>()(
    'notifications',
    ['notifications:probe-unread-view', ELECTRON_EVENT],
    { optionalMember: true }
  ),
  'notifications.peekPendingOpenSession': callable<
    () => Promise<OpenSessionFromNotificationRequest | null>
  >()('notifications', ['notifications:peek-pending-open-session']),
  'notifications.syncViewState': callable<(state: UnreadTaskViewState) => void>()(
    'notifications',
    ['notifications:sync-unread-view', SEND],
    { optionalMember: true }
  ),
  'notifications.takePendingOpenSession': callable<
    (expectedToken: number) => Promise<OpenSessionFromNotificationRequest | null>
  >()('notifications', ['notifications:take-pending-open-session']),
  'officePreview.attachFrame': callable<
    (sessionId: string) => Promise<OfficePreviewAttachResult | undefined>
  >()('office-preview', ['office-preview:attach-frame', ELECTRON]),
  'officePreview.close': callable<(sessionId: string) => Promise<void>>()('office-preview', [
    'office-preview:close',
    ELECTRON
  ]),
  'officePreview.onState': callable<
    (listener: (state: OfficePreviewRuntimeState) => void) => RemoveListener
  >()('office-preview', ['office-preview:state', ELECTRON_EVENT]),
  'officePreview.open': callable<
    (request: OfficePreviewOpenRequest) => Promise<OfficePreviewOpenResult>
  >()('office-preview', ['office-preview:open', ELECTRON]),
  'officePreview.reportState': callable<
    (sessionId: string, state: OfficePreviewRuntimeState) => void
  >()('office-preview', ['office-preview:report-state', SEND]),
  'permissions.extendUndo': callable<
    (request: PermissionGrantUndoExtendRequest) => Promise<PermissionGrantUndoReceipt | undefined>
  >()('permissions', ['permissions:extend-undo']),
  'permissions.list': callable<() => Promise<PermissionGrantSnapshot>>()('permissions', [
    'permissions:list'
  ]),
  'permissions.restoreDefaults': callable<() => Promise<PermissionGrantDefaultsRestoreView>>()(
    'permissions',
    ['permissions:restore-defaults']
  ),
  'permissions.onChanged': callable<
    (listener: AcpListener<PermissionGrantsChangedEvent>) => RemoveListener
  >()('permissions', ['permissions:changed', EVENT]),
  'permissions.restore': callable<
    (request: PermissionGrantRestoreRequest) => Promise<PermissionGrantMutationView>
  >()('permissions', ['permissions:restore']),
  'permissions.revoke': callable<
    (request: PermissionGrantRevokeRequest) => Promise<PermissionGrantMutationView>
  >()('permissions', ['permissions:revoke']),
  platform: value<string>()('platform-file-save'),
  'preview.delete': callable<(request: DeletePreviewStateRequest) => Promise<void>>()('preview', [
    'preview:delete'
  ]),
  'preview.load': callable<
    (request: LoadPreviewStateRequest) => Promise<PreviewStateSnapshot | null>
  >()('preview', ['preview:load']),
  'preview.save': callable<(request: SavePreviewStateRequest) => Promise<SavePreviewStateResult>>()(
    'preview',
    ['preview:save']
  ),
  'previewContextMenu.onRequested': callable<
    (listener: AcpListener<PreviewContextMenuRequest>) => RemoveListener
  >()('preview-context-menu', [PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL, ELECTRON_EVENT]),
  'previewResources.acquire': callable<
    (request: AcquireManagedPreviewRequest) => Promise<ManagedPreviewResource>
  >()('preview-resources', ['preview-resources:acquire']),
  'previewResources.readRange': callable<
    (request: ReadManagedPreviewRangeRequest) => Promise<ManagedPreviewRangeResult>
  >()('preview-resources', ['preview-resources:read-range']),
  'previewResources.release': callable<(request: ReleaseManagedPreviewRequest) => Promise<void>>()(
    'preview-resources',
    ['preview-resources:release']
  ),
  'projectFiles.getOverview': callable<
    (request: GetProjectFilesOverviewRequest) => Promise<ProjectFilesOverview>
  >()('project-files', ['project-files:get-overview']),
  'projectFiles.listArtifactGroups': callable<
    (request: ListArtifactGroupsRequest) => Promise<ArtifactGroupPage>
  >()('project-files', ['project-files:list-artifact-groups']),
  'projectFiles.listFiles': callable<
    (request: ListProjectFilesRequest) => Promise<ProjectFilesPage>
  >()('project-files', ['project-files:list-files']),
  'projectFiles.resolveFile': callable<
    (request: ResolveProjectFileRequest) => Promise<ProjectFileItem | undefined>
  >()('project-files', ['project-files:resolve-file']),
  'projectFiles.onChanged': callable<
    (listener: AcpListener<ProjectFilesChangedEvent>) => RemoveListener
  >()('project-files', ['project-files:changed', EVENT]),
  'projectFiles.repairIndex': callable<(request: { projectId: string }) => Promise<void>>()(
    'project-files',
    ['project-files:repair-index']
  ),
  'projectFiles.searchArtifacts': callable<
    (request: SearchArtifactsRequest) => Promise<SearchArtifactsResult>
  >()('project-files', ['project-files:search-artifacts']),
  'projects.create': callable<(request: CreateProjectRequest) => Promise<Project>>()('projects', [
    'projects:create',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.delete': callable<(request: DeleteProjectRequest) => Promise<ProjectDeletionOutcome>>()(
    'projects',
    ['projects:delete', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'projects.get': callable<(id: string) => Promise<Project | null>>()('projects', [
    'projects:get',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.list': callable<() => Promise<Project[]>>()('projects', [
    'projects:list',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.listDeletionCleanup': callable<() => Promise<ProjectDeletionCleanup[]>>()('projects', [
    'projects:list-deletion-cleanup',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.onCreated': callable<(listener: AcpListener<Project>) => RemoveListener>()('projects', [
    'project:created',
    EVENT
  ]),
  'projects.onDeleted': callable<(listener: AcpListener<ProjectDeletedEvent>) => RemoveListener>()(
    'projects',
    ['project:deleted', EVENT]
  ),
  'projects.onDeletionCleanupChanged': callable<
    (listener: AcpListener<undefined>) => RemoveListener
  >()('projects', ['project:deletion-cleanup-changed', EVENT]),
  'projects.onUpdated': callable<(listener: AcpListener<Project>) => RemoveListener>()('projects', [
    'project:updated',
    EVENT
  ]),
  'projects.update': callable<(request: UpdateProjectRequest) => Promise<Project>>()('projects', [
    'projects:update',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.retryDeletionCleanup': callable<() => Promise<void>>()('projects', [
    'projects:retry-deletion-cleanup',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.updateArchive': callable<(request: UpdateProjectArchiveRequest) => Promise<Project>>()(
    'projects',
    ['projects:update-archive', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'remoteAccess.approve': callable<
    (request: ApproveRemotePairingRequest) => Promise<RemoteAccessSnapshot>
  >()('remote-access', ['remote-access:approve']),
  'remoteAccess.detect': callable<() => Promise<RemoteAccessSnapshot>>()('remote-access', [
    'remote-access:detect',
    ELECTRON
  ]),
  'remoteAccess.probe': callable<() => Promise<RemoteAccessSnapshot>>()('remote-access', [
    'remote-access:probe',
    LOCAL
  ]),
  'remoteAccess.disable': callable<() => Promise<RemoteAccessSnapshot>>()('remote-access', [
    'remote-access:disable',
    ELECTRON
  ]),
  'remoteAccess.getSnapshot': callable<() => Promise<RemoteAccessSnapshot>>()('remote-access', [
    'remote-access:get-snapshot'
  ]),
  'remoteAccess.onChanged': callable<(listener: () => void) => RemoveListener>()('remote-access', [
    'remote-access:changed',
    EVENT
  ]),
  'remoteAccess.reject': callable<
    (request: RemotePairingRequestId) => Promise<RemoteAccessSnapshot>
  >()('remote-access', ['remote-access:reject']),
  'remoteAccess.revokeBrowser': callable<
    (request: RevokeRemoteBrowserRequest) => Promise<RemoteAccessSnapshot>
  >()('remote-access', ['remote-access:revoke-browser']),
  'remoteAccess.setMode': callable<
    (request: SetRemoteAccessModeRequest) => Promise<RemoteAccessSnapshot>
  >()('remote-access', ['remote-access:set-mode', ELECTRON]),
  'reviewer.abortFixLoop': callable<(request: ReviewSessionRequest) => Promise<void>>()(
    'reviewer',
    ['reviewer:abort-fix-loop']
  ),
  'reviewer.getForSession': callable<
    (request: ReviewSessionRequest) => Promise<ReviewWithChecks[]>
  >()('reviewer', ['reviewer:get-for-session']),
  'reviewer.onFixLoopEnd': callable<
    (listener: AcpListener<ReviewSessionRequest>) => RemoveListener
  >()('reviewer', ['reviewer:fix-loop-end', EVENT]),
  'reviewer.onFixLoopStart': callable<
    (listener: AcpListener<ReviewSessionRequest>) => RemoveListener
  >()('reviewer', ['reviewer:fix-loop-start', EVENT]),
  'reviewer.onSuppressNextAutoReview': callable<
    (listener: AcpListener<ReviewSuppressionEvent>) => RemoveListener
  >()('reviewer', ['reviewer:suppress-next-auto-review', EVENT]),
  'reviewer.onUpdated': callable<(listener: AcpListener<ReviewUpdateEvent>) => RemoveListener>()(
    'reviewer',
    ['reviewer:updated', EVENT]
  ),
  'reviewer.run': callable<(request: ReviewRunRequest) => Promise<ReviewRunResult>>()('reviewer', [
    'reviewer:run'
  ]),
  'runtime.describeUsage': callable<
    (language: NotebookLanguage, envId: string) => Promise<RuntimeUsage>
  >()('runtime', ['runtime:describe-usage', WEB, RUNTIME_LANGUAGE_ENV]),
  'runtime.getAgentEnvironmentCreationEnabled': callable<() => Promise<boolean>>()('runtime', [
    'runtime:get-agent-environment-creation-enabled',
    WEB
  ]),
  'runtime.getEnablement': callable<(language: NotebookLanguage) => Promise<RuntimeEnablement>>()(
    'runtime',
    ['runtime:get-enablement', WEB, RUNTIME_LANGUAGE]
  ),
  'runtime.listEnvironments': callable<
    () => Promise<{ python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }>
  >()('runtime', ['runtime:list-environments']),
  'runtime.listPackageCounts': callable<
    (language: NotebookLanguage) => Promise<Record<string, number | null>>
  >()('runtime', ['runtime:list-package-counts', WEB, RUNTIME_LANGUAGE]),
  'runtime.listPackages': callable<
    (language: NotebookLanguage, envId: string) => Promise<EnvPackage[]>
  >()('runtime', ['runtime:list-packages', WEB, RUNTIME_LANGUAGE_ENV]),
  'runtime.pickInterpreter': callable<() => Promise<string | null>>()('runtime', [
    'runtime:pick-interpreter',
    LOCAL
  ]),
  'runtime.registerInterpreter': callable<
    (language: NotebookLanguage, path: string) => Promise<string[]>
  >()('runtime', ['runtime:register-interpreter', LOCAL, RUNTIME_INTERPRETER]),
  'runtime.setAgentEnvironmentCreationEnabled': callable<
    (request: { enabled: boolean }) => Promise<boolean>
  >()('runtime', ['runtime:set-agent-environment-creation-enabled', LOCAL]),
  'runtime.setEnvironmentEnabled': callable<
    (
      language: NotebookLanguage,
      envId: string,
      enabled: boolean,
      force?: boolean
    ) => Promise<RuntimeEnablement>
  >()('runtime', ['runtime:set-environment-enabled', LOCAL, RUNTIME_ENABLEMENT]),
  'runtime.setInstallAuthorized': callable<
    (language: NotebookLanguage, envId: string, authorized: boolean) => Promise<RuntimeEnablement>
  >()('runtime', ['runtime:set-install-authorized', LOCAL, RUNTIME_INSTALL_AUTH]),
  'runtime.unregisterInterpreter': callable<
    (language: NotebookLanguage, path: string) => Promise<string[]>
  >()('runtime', ['runtime:unregister-interpreter', LOCAL, RUNTIME_INTERPRETER]),
  saveBlobFile: callable<(request: SaveBlobFileRequest) => Promise<SaveBlobFileResult>>()(
    'platform-file-save',
    ['file:save-blob', MAPPED_NATIVE]
  ),
  saveManagedFile: callable<(request: SaveManagedFileRequest) => Promise<SaveManagedFileResult>>()(
    'platform-file-save',
    ['file:save-managed', DELEGATED_NATIVE]
  ),
  saveProjectArtifacts: callable<
    (request: SaveProjectArtifactsRequest) => Promise<SaveProjectArtifactsResult>
  >()('platform-file-save', ['file:save-project-artifacts', MAPPED_ELECTRON]),
  saveSessionArtifacts: callable<
    (request: SaveSessionArtifactsRequest) => Promise<SaveSessionArtifactsResult>
  >()('platform-file-save', ['file:save-session-artifacts', MAPPED_ELECTRON]),
  'sessions.deleteSession': callable<
    (request: DeleteSessionRequest) => Promise<SessionDeletionResult>
  >()('sessions', ['sessions:delete-session', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.editDetails': callable<
    (request: EditSessionDetailsRequest) => Promise<PersistedChatSession>
  >()('sessions', ['sessions:edit-details', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.exportConversation': callable<
    (request: ExportConversationRequest) => Promise<ExportConversationResult>
  >()('sessions', ['sessions:export-conversation', MAPPED_ELECTRON]),
  'sessions.list': callable<() => Promise<ListSessionSummariesResult>>()('sessions', [
    'sessions:list'
  ]),
  'sessions.filterPdfContextCandidates': callable<
    (
      request: FilterSessionPdfContextCandidatesRequest
    ) => Promise<FilterSessionPdfContextCandidatesResult>
  >()('sessions', [
    'sessions:filter-pdf-context-candidates',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessions.linkPdfContext': callable<
    (request: LinkSessionPdfContextRequest) => Promise<SessionRuntimeContext>
  >()('sessions', ['sessions:link-pdf-context', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.loadAll': callable<() => Promise<LoadAllSessionsResult>>()('sessions', [
    'sessions:load-all'
  ]),
  'sessions.loadOne': callable<
    (request: LoadSessionRequest) => Promise<PersistedChatSession | undefined>
  >()('sessions', ['sessions:load-one']),
  'sessions.loadUsage': callable<() => Promise<SessionUsageProjection>>()('sessions', [
    'sessions:load-usage'
  ]),
  'sessions.openRecoveryFolder': callable<
    (request: OpenSessionRecoveryFolderRequest) => Promise<void>
  >()('sessions', ['sessions:open-recovery-folder', MAPPED_ELECTRON], { optionalMember: true }),
  'sessions.onCreated': callable<(listener: AcpListener<SessionUpsertEvent>) => RemoveListener>()(
    'sessions',
    ['session:created', EVENT]
  ),
  'sessions.onDeleted': callable<(listener: AcpListener<SessionDeletedEvent>) => RemoveListener>()(
    'sessions',
    ['session:deleted', EVENT]
  ),
  'sessions.onFlushAborted': callable<
    (listener: AcpListener<SessionPersistenceFlushAbortedEvent | undefined>) => RemoveListener
  >()('sessions', ['sessions:flush-aborted', EVENT], { optionalMember: true }),
  'sessions.onFlushRequest': callable<
    (listener: AcpListener<SessionPersistenceFlushRequest>) => RemoveListener
  >()('sessions', ['sessions:flush-request', EVENT], { optionalMember: true }),
  'sessions.onUpdated': callable<(listener: AcpListener<SessionUpsertEvent>) => RemoveListener>()(
    'sessions',
    ['session:updated', EVENT]
  ),
  'sessions.saveManifest': callable<(request: SaveSessionManifestRequest) => Promise<void>>()(
    'sessions',
    ['sessions:save-manifest']
  ),
  'sessions.saveSession': callable<
    (session: PersistedChatSession, options?: SaveSessionOptions) => Promise<PersistedChatSession>
  >()('sessions', ['sessions:save-session', WEB, SESSION_SAVE, SESSION_SAVE_JSON]),
  'sessions.setDelegationPolicy': callable<
    (
      projectId: string,
      sessionId: string,
      policy: DelegationPolicy
    ) => Promise<PersistedChatSession>
  >()('sessions', ['sessions:set-delegation-policy', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.sendFlushResponse': callable<(response: SessionPersistenceFlushResponse) => void>()(
    'sessions',
    ['sessions:flush-response', SEND],
    { optionalMember: true }
  ),
  'sessions.updateArchive': callable<
    (request: UpdateSessionArchiveRequest) => Promise<PersistedChatSession>
  >()('sessions', ['sessions:update-archive']),
  'sessions.unlinkPdfContext': callable<
    (request: UnlinkSessionPdfContextRequest) => Promise<SessionRuntimeContext>
  >()('sessions', ['sessions:unlink-pdf-context', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'settings.addCustomServer': callable<
    (request: AddCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:add-custom-server', LOCAL]),
  'settings.createDeviceCredential': callable<
    (request: CreateDeviceCredentialRequest) => Promise<CreateDeviceCredentialResult>
  >()('settings', ['settings:create-device-credential', LOCAL]),
  'settings.authenticateDeviceCredential': callable<
    (request: DeviceCredentialAuthenticationRequest) => Promise<DeviceCredentialsSnapshot>
  >()('settings', ['settings:authenticate-device-credential', LOCAL]),
  'settings.cancelDeviceCredentialAuthentication': callable<
    (request: DeviceCredentialAuthenticationRequest) => Promise<void>
  >()('settings', ['settings:cancel-device-credential-authentication', LOCAL]),
  'settings.disconnectDeviceCredential': callable<
    (request: DeviceCredentialAuthenticationRequest) => Promise<DeviceCredentialsSnapshot>
  >()('settings', ['settings:disconnect-device-credential', LOCAL]),
  'settings.authenticateCustomServer': callable<
    (request: DisconnectCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:authenticate-custom-server', LOCAL]),
  'settings.beginXaiOAuthLogin': callable<() => Promise<XaiOAuthDeviceAuthorization>>()(
    'settings',
    ['settings:begin-xai-oauth-login', LOCAL]
  ),
  'settings.cancelClaudeLogin': callable<() => Promise<void>>()('settings', [
    'settings:cancel-claude-login',
    LOCAL
  ]),
  'settings.cancelCodexLogin': callable<() => Promise<void>>()('settings', [
    'settings:cancel-codex-login',
    LOCAL
  ]),
  'settings.cancelCustomServerAuthentication': callable<
    (request: AuthenticateCustomServerRequest) => Promise<void>
  >()('settings', ['settings:cancel-custom-server-authentication', LOCAL]),
  'settings.disconnectCustomServer': callable<
    (request: AuthenticateCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:disconnect-custom-server', LOCAL]),
  'settings.cancelIsolatedClaudeLogin': callable<() => Promise<void>>()('settings', [
    'settings:cancel-isolated-claude-login',
    LOCAL
  ]),
  'settings.cancelXaiOAuthLogin': callable<() => Promise<void>>()('settings', [
    'settings:cancel-xai-oauth-login',
    LOCAL
  ]),
  'settings.checkEnvironment': callable<() => Promise<EnvironmentCheckResult>>()('settings', [
    'settings:check-environment'
  ]),
  'settings.createSkill': callable<(request: CreateSkillRequest) => Promise<SkillView[]>>()(
    'settings',
    ['settings:create-skill']
  ),
  'settings.deleteProvider': callable<
    (request: DeleteProviderRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:delete-provider']),
  'settings.deleteSkill': callable<(request: DeleteSkillRequest) => Promise<SkillView[]>>()(
    'settings',
    ['settings:delete-skill']
  ),
  'settings.detectClaude': callable<() => Promise<ClaudeDetectResult>>()('settings', [
    'settings:detect-claude'
  ]),
  'settings.detectCodeBuddy': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:detect-codebuddy'
  ]),
  'settings.detectCodex': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:detect-codex'
  ]),
  'settings.detectOpencode': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:detect-opencode'
  ]),
  'settings.exportCustomServerTemplate': callable<
    (request: ExportCustomServerTemplateRequest) => Promise<ExportCustomServerTemplateResult>
  >()('settings', ['settings:export-custom-server-template', ELECTRON]),
  'settings.exportSkill': callable<(request: ExportSkillRequest) => Promise<ExportSkillResult>>()(
    'settings',
    ['settings:export-skill', ELECTRON]
  ),
  'settings.getConnectorDetail': callable<(id: string) => Promise<ConnectorDetailView>>()(
    'settings',
    ['settings:get-connector-detail']
  ),
  'settings.getGitHubTokenStatus': callable<() => Promise<GitHubTokenStatus>>()('settings', [
    'settings:get-github-token-status',
    LOCAL
  ]),
  'settings.getPackageMirror': callable<() => Promise<PackageMirror>>()('settings', [
    'settings:get-package-mirror'
  ]),
  'settings.getPreflight': callable<() => Promise<Preflight>>()('settings', [
    'settings:get-preflight'
  ]),
  'settings.getSettings': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:get-settings'
  ]),
  'settings.getSkillDetail': callable<(id: string) => Promise<SkillDetailView>>()('settings', [
    'settings:get-skill-detail'
  ]),
  // Electron-only: the connector-skill document sources live on the main-process filesystem, so
  // the web adapter does not project this member — renderer callers must guard its presence.
  'settings.resolveSkillDocument': callable<
    (request: ResolveSkillDocumentRequest) => Promise<ResolvedSkillDocument | null>
  >()('settings', ['settings:resolve-skill-document', ELECTRON]),
  'settings.importAgentHomeSkills': callable<
    (request: ImportAgentHomeSkillsRequest) => Promise<ImportAgentHomeSkillsResult>
  >()('settings', ['settings:import-agent-home-skills', MAPPED_ELECTRON]),
  'settings.importSkill': callable<(request: ImportSkillRequest) => Promise<ImportSkillResult>>()(
    'settings',
    ['settings:import-skill']
  ),
  'settings.importSkillZip': callable<
    (request: ImportSkillZipRequest) => Promise<ImportSkillResult>
  >()('settings', ['settings:import-skill-zip']),
  'settings.importSkillZipBatch': callable<
    (request: ImportSkillZipBatchRequest) => Promise<ImportSkillZipBatchResult>
  >()('settings', ['settings:import-skill-zip-batch']),
  'settings.installClaude': callable<
    (request: InstallClaudeRequest) => Promise<ClaudeInstallResult>
  >()('settings', ['settings:install-claude', LOCAL]),
  'settings.installCodeBuddy': callable<
    (request: InstallCodeBuddyRequest) => Promise<ClaudeInstallResult>
  >()('settings', ['settings:install-codebuddy', LOCAL]),
  'settings.installCodex': callable<
    (request: InstallCodexRequest) => Promise<ClaudeInstallResult>
  >()('settings', ['settings:install-codex', LOCAL]),
  'settings.installOpencode': callable<
    (request: InstallOpencodeRequest) => Promise<ClaudeInstallResult>
  >()('settings', ['settings:install-opencode', LOCAL]),
  'settings.isEncryptionAvailable': callable<() => Promise<boolean>>()('settings', [
    'settings:encryption-available'
  ]),
  'settings.isNpmAvailable': callable<() => Promise<boolean>>()('settings', [
    'settings:npm-available'
  ]),
  'settings.listAgentHomeSkills': callable<() => Promise<AgentHomeSkillView[]>>()('settings', [
    'settings:list-agent-home-skills',
    MAPPED_ELECTRON
  ]),
  'settings.listAppIcons': callable<() => Promise<AppIconPreview[]>>()('settings', [
    'settings:list-app-icons'
  ]),
  'settings.listConnectors': callable<() => Promise<ConnectorsSnapshot>>()('settings', [
    'settings:list-connectors'
  ]),
  'settings.listDeviceCredentials': callable<() => Promise<DeviceCredentialsSnapshot>>()(
    'settings',
    ['settings:list-device-credentials', LOCAL]
  ),
  'settings.listSkills': callable<() => Promise<SkillView[]>>()('settings', [
    'settings:list-skills'
  ]),
  'settings.loginIsolatedClaude': callable<(token: string) => Promise<ValidateProviderResult>>()(
    'settings',
    ['settings:login-isolated-claude', LOCAL]
  ),
  'settings.loginIsolatedClaudeBrowser': callable<() => Promise<ValidateProviderResult>>()(
    'settings',
    ['settings:login-isolated-claude-browser', LOCAL]
  ),
  'settings.loginIsolatedCodex': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:login-isolated-codex',
    LOCAL
  ]),
  'settings.loginSharedClaude': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:login-shared-claude',
    LOCAL
  ]),
  'settings.logoutIsolatedClaude': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:logout-isolated-claude',
    LOCAL
  ]),
  'settings.logoutIsolatedCodex': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:logout-isolated-codex',
    LOCAL
  ]),
  'settings.logoutSharedClaude': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:logout-shared-claude',
    LOCAL
  ]),
  'settings.logoutXaiOAuth': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:logout-xai-oauth',
    LOCAL
  ]),
  'settings.markOnboardingComplete': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:mark-onboarding-complete'
  ]),
  'settings.onChanged': callable<(listener: (snapshot: SettingsSnapshot) => void) => () => void>()(
    'settings',
    ['settings:changed', EVENT]
  ),
  'settings.onConnectorApprovalRequest': callable<
    (listener: AcpListener<ConnectorApprovalRequest>) => RemoveListener
  >()('settings', ['connectors:approval-request', EVENT]),
  'settings.onConnectorApprovalSettled': callable<
    (listener: AcpListener<string>) => RemoveListener
  >()('settings', ['connectors:approval-settled', EVENT], { optionalMember: true }),
  'settings.onConnectorCredentialRequest': callable<
    (listener: AcpListener<ConnectorCredentialRequest>) => RemoveListener
  >()('settings', ['connectors:credential-request', ELECTRON_EVENT], { optionalMember: true }),
  'settings.onConnectorCredentialSettled': callable<
    (listener: AcpListener<string>) => RemoveListener
  >()('settings', ['connectors:credential-settled', ELECTRON_EVENT], { optionalMember: true }),
  'settings.onConnectorRuntimeChanged': callable<
    (listener: AcpListener<undefined>) => RemoveListener
  >()('settings', ['settings:connector-runtime-changed', EVENT]),
  'settings.onInstallLog': callable<
    (listener: AcpListener<ClaudeInstallEvent>) => RemoveListener
  >()('settings', ['settings:install-log', EVENT]),
  'settings.onSkillCatalogChanged': callable<
    (listener: AcpListener<undefined>) => RemoveListener
  >()('settings', ['skills:catalog-changed', EVENT]),
  'settings.onSkillImportApprovalRequest': callable<
    (listener: AcpListener<ConversationSkillImportApprovalRequest>) => RemoveListener
  >()('settings', ['skills:conversation-import-request', EVENT]),
  'settings.onSkillImportApprovalSettled': callable<
    (listener: AcpListener<string>) => RemoveListener
  >()('settings', ['skills:conversation-import-settled', EVENT]),
  'settings.previewAgentHomeSkill': callable<
    (request: PreviewAgentHomeSkillRequest) => Promise<SkillImportPreviewContent>
  >()('settings', ['settings:preview-agent-home-skill']),
  'settings.previewCustomServerTemplateExport': callable<
    (id: string) => Promise<ConnectorTemplateExportPreview>
  >()('settings', ['settings:preview-custom-server-template-export', ELECTRON]),
  'settings.previewGitHubSkill': callable<
    (request: PreviewGitHubSkillRequest) => Promise<SkillImportPreviewContent>
  >()('settings', ['settings:preview-github-skill']),
  'settings.previewSkillZip': callable<
    (request: PreviewSkillZipRequest) => Promise<SkillBundlePreviewResult>
  >()('settings', ['settings:preview-skill-zip']),
  'settings.refreshProviderModels': callable<
    (request: RefreshProviderModelsRequest) => Promise<RefreshProviderModelsResult>
  >()('settings', ['settings:refresh-provider-models']),
  'settings.removeCustomServer': callable<
    (request: RemoveCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:remove-custom-server', LOCAL]),
  'settings.removeDeviceCredential': callable<
    (request: RemoveDeviceCredentialRequest) => Promise<DeviceCredentialsSnapshot>
  >()('settings', ['settings:remove-device-credential', LOCAL]),
  'settings.removeGitHubToken': callable<() => Promise<GitHubTokenStatus>>()('settings', [
    'settings:remove-github-token',
    LOCAL
  ]),
  'settings.replayConnectorApproval': callable<
    (id: string) => Promise<ConnectorApprovalRequest | null>
  >()('settings', ['connectors:approval-replay']),
  'settings.replayPendingConnectorApprovals': callable<() => Promise<void>>()(
    'settings',
    ['connectors:approval-replay-pending'],
    { optionalMember: true }
  ),
  'settings.replayPendingConnectorCredentialRequests': callable<() => Promise<void>>()(
    'settings',
    ['connectors:credential-replay-pending', ELECTRON],
    { optionalMember: true }
  ),
  'settings.replayPendingSkillImportApprovals': callable<() => Promise<void>>()('settings', [
    'skills:conversation-import-replay-pending'
  ]),
  'settings.respondConnectorApproval': callable<
    (request: RespondApprovalRequest) => Promise<void>
  >()('settings', ['connectors:approval-respond']),
  'settings.respondConnectorCredentialRequest': callable<
    (request: RespondConnectorCredentialRequest) => Promise<void>
  >()('settings', ['connectors:credential-respond', ELECTRON], { optionalMember: true }),
  'settings.respondSkillImportApproval': callable<
    (response: ConversationSkillImportApprovalResponse) => Promise<void>
  >()('settings', ['skills:conversation-import-respond']),
  'settings.retryConnectorProjection': callable<() => Promise<ConnectorsSnapshot>>()('settings', [
    'settings:retry-connector-projection',
    LOCAL
  ]),
  'settings.retryCustomServer': callable<
    (request: AuthenticateCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:retry-custom-server', LOCAL]),
  'settings.saveGitHubToken': callable<
    (request: SaveGitHubTokenRequest) => Promise<GitHubTokenStatus>
  >()('settings', ['settings:save-github-token', LOCAL]),
  'settings.scanRepoSkills': callable<(request: ScanRepoRequest) => Promise<ScanRepoResult>>()(
    'settings',
    ['settings:scan-repo-skills']
  ),
  'settings.selectCustomServerTemplate': callable<
    (request?: SelectCustomServerTemplateRequest) => Promise<ConnectorTemplateSelectionResult>
  >()('settings', ['settings:select-custom-server-template', ELECTRON]),
  'settings.setActiveProvider': callable<
    (request: SetActiveProviderRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-active-provider']),
  'settings.setAgentFramework': callable<
    (request: SetAgentFrameworkRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-agent-framework']),
  'settings.setAppIconVariant': callable<
    (request: SetAppIconVariantRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-app-icon-variant', LOCAL]),
  'settings.setClosePreference': callable<
    (request: SetClosePreferenceRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-close-preference', LOCAL]),
  'settings.setConnectorAutoAllow': callable<
    (request: SetConnectorAutoAllowRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-connector-auto-allow']),
  'settings.setConnectorEnabled': callable<
    (request: SetConnectorEnabledRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-connector-enabled']),
  'settings.setConversationSkillImportEnabled': callable<
    (request: SetConversationSkillImportEnabledRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-conversation-skill-import-enabled']),
  'settings.setCustomServerEnabled': callable<
    (request: SetCustomServerEnabledRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-custom-server-enabled', LOCAL]),
  'settings.setDefaultPermissionProfile': callable<
    (request: SetDefaultPermissionProfileRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-default-permission-profile', LOCAL]),
  'settings.setNcbiCredentials': callable<
    (request: SetNcbiCredentialsRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-ncbi-credentials']),
  'settings.setOpenAlexCredential': callable<
    (request: SetOpenAlexCredentialRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-openalex-credential', LOCAL]),
  'settings.validateOpenAlexCredential': callable<
    (request: ValidateOpenAlexCredentialRequest) => Promise<OpenAlexCredentialValidation>
  >()('settings', ['settings:validate-openalex-credential', LOCAL]),
  'settings.setNetworkProxy': callable<
    (request: SetNetworkProxyRequest) => Promise<NetworkProxySettings>
  >()('settings', ['settings:set-network-proxy', LOCAL]),
  'settings.setNotebookNetwork': callable<
    (request: SetNotebookNetworkRequest) => Promise<NotebookNetworkSettings>
  >()('settings', ['settings:set-notebook-network', LOCAL]),
  'settings.getNotebookNetworkStatus': callable<() => Promise<NotebookNetworkStatus>>()(
    'settings',
    ['settings:get-notebook-network-status', LOCAL]
  ),
  'settings.installNotebookNetwork': callable<() => Promise<NotebookNetworkStatus>>()('settings', [
    'settings:install-notebook-network',
    LOCAL
  ]),
  'settings.removeNotebookNetwork': callable<() => Promise<NotebookNetworkStatus>>()('settings', [
    'settings:remove-notebook-network',
    LOCAL
  ]),
  'settings.setNotificationsEnabled': callable<
    (request: SetNotificationsEnabledRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-notifications-enabled', LOCAL]),
  'settings.setShowNotificationContent': callable<
    (request: SetShowNotificationContentRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-show-notification-content', LOCAL]),
  'settings.setPackageMirror': callable<
    (request: SetPackageMirrorRequest) => Promise<PackageMirror>
  >()('settings', ['settings:set-package-mirror', LOCAL]),
  'settings.setProjectFilesFilter': callable<
    (request: SetProjectFilesFilterRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-project-files-filter', LOCAL]),
  'settings.setReasoningEffort': callable<
    (request: SetReasoningEffortRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-reasoning-effort']),
  'settings.setReviewerModel': callable<
    (request: SetReviewerModelRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-reviewer-model']),
  'settings.setSessionDetailsModel': callable<
    (request: SetSessionDetailsModelRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-session-details-model']),
  'settings.setSkillEnabled': callable<(request: SetSkillEnabledRequest) => Promise<SkillView[]>>()(
    'settings',
    ['settings:set-skill-enabled']
  ),
  'settings.setSkillsEnabled': callable<
    (request: SetSkillsEnabledRequest) => Promise<SkillView[]>
  >()('settings', ['settings:set-skills-enabled']),
  'settings.setSubagentModel': callable<
    (request: SetSubagentModelRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-subagent-model']),
  'settings.setToolPermission': callable<
    (request: SetToolPermissionRequest) => Promise<ConnectorDetailView>
  >()('settings', ['settings:set-tool-permission']),
  'settings.setVisionModel': callable<
    (request: SetVisionModelRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-vision-model']),
  'settings.uninstallClaude': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:uninstall-claude',
    LOCAL
  ]),
  'settings.uninstallCodeBuddy': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:uninstall-codebuddy',
    LOCAL
  ]),
  'settings.uninstallCodex': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:uninstall-codex',
    LOCAL
  ]),
  'settings.uninstallOpencode': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:uninstall-opencode',
    LOCAL
  ]),
  'settings.updateCustomServer': callable<
    (request: UpdateCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:update-custom-server', LOCAL]),
  'settings.updateDeviceCredential': callable<
    (request: UpdateDeviceCredentialRequest) => Promise<DeviceCredentialsSnapshot>
  >()('settings', ['settings:update-device-credential', LOCAL]),
  'settings.updateSkill': callable<(request: UpdateSkillRequest) => Promise<SkillView[]>>()(
    'settings',
    ['settings:update-skill']
  ),
  'settings.upsertProvider': callable<
    (request: UpsertProviderRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:upsert-provider']),
  'settings.validateProvider': callable<
    (request: ValidateProviderRequest) => Promise<ValidateProviderResult>
  >()('settings', ['settings:validate-provider']),
  'settings.waitXaiOAuthLogin': callable<() => Promise<{ accountEmail?: string }>>()('settings', [
    'settings:wait-xai-oauth-login',
    LOCAL
  ]),
  'sideChat.cancel': callable<(request: SideChatSessionRequest) => Promise<void>>()('side-chat', [
    'side-chat:cancel',
    ELECTRON
  ]),
  'sideChat.close': callable<(request: SideChatCloseRequest) => Promise<void>>()('side-chat', [
    'side-chat:close',
    ELECTRON
  ]),
  'sideChat.list': callable<() => Promise<SideChatSnapshotList>>()('side-chat', [
    'side-chat:list',
    ELECTRON
  ]),
  'sideChat.onEvent': callable<(listener: AcpListener<SideChatRuntimeEvent>) => RemoveListener>()(
    'side-chat',
    ['side-chat:event', ELECTRON_EVENT]
  ),
  'sideChat.onRelayDelivered': callable<
    (listener: AcpListener<SideChatRelayDeliveredEvent>) => RemoveListener
  >()('side-chat', ['side-chat:relay-delivered', ELECTRON_EVENT]),
  'sideChat.send': callable<(request: SideChatPromptRequest) => Promise<void>>()('side-chat', [
    'side-chat:send',
    ELECTRON
  ]),
  'sideChat.start': callable<(request: SideChatStartRequest) => Promise<SideChatStartResponse>>()(
    'side-chat',
    ['side-chat:start', ELECTRON]
  ),
  'sourcePreview.onLoadState': callable<
    (listener: (state: SourcePreviewLoadState) => void) => RemoveListener
  >()('source-preview', [SOURCE_PREVIEW_LOAD_STATE_CHANNEL, ELECTRON_EVENT], {
    optionalRoot: true
  }),
  'sourcePreview.release': callable<(sourceUrl: string) => void>()(
    'source-preview',
    [SOURCE_PREVIEW_RELEASE_CHANNEL, SEND],
    { optionalRoot: true }
  ),
  'specialist.addMarketplaceSource': callable<
    (request: AddMarketplaceSourceRequest) => Promise<MarketplaceSourceView>
  >()('specialist', ['specialist:marketplace-source-add', ELECTRON]),
  'specialist.cancelHandoff': callable<(request: CompletionHandoffCommand) => Promise<void>>()(
    'specialist',
    ['specialist:cancel-handoff', ELECTRON]
  ),
  'specialist.cancelMarketplaceCandidate': callable<
    (request: CancelMarketplaceCandidateRequest) => Promise<void>
  >()('specialist', ['specialist:marketplace-candidate-cancel', ELECTRON]),
  'specialist.cancelPackage': callable<
    (request: SpecialistPackageInstallRequest) => Promise<void>
  >()('specialist', ['specialist:package-cancel', ELECTRON]),
  'specialist.create': callable<(request: CreateSpecialistRequest) => Promise<SpecialistView>>()(
    'specialist',
    ['specialist:create', ELECTRON]
  ),
  'specialist.delete': callable<
    (request: SpecialistDeleteRequest) => Promise<SpecialistDeleteResult>
  >()('specialist', ['specialist:delete', ELECTRON]),
  'specialist.duplicate': callable<
    (request: DuplicateSpecialistRequest) => Promise<CreateSpecialistRequest>
  >()('specialist', ['specialist:duplicate', ELECTRON]),
  'specialist.exportContributionTemplate': callable<
    () => Promise<ContributionTemplateExportResult>
  >()('specialist', ['specialist:export-contribution-template', ELECTRON]),
  'specialist.exportSpecialist': callable<
    (request: SpecialistExportRequest) => Promise<SpecialistExportSaveResult>
  >()('specialist', ['specialist:export-save', ELECTRON]),
  'specialist.getHandoffEvents': callable<
    (sessionId: string) => Promise<CompletionHandoffLifecycleEvent[]>
  >()('specialist', ['specialist:get-handoff-events', ELECTRON]),
  'specialist.getMarketplaceRelease': callable<
    (request: GetMarketplaceReleaseRequest) => Promise<MarketplaceSpecialistRelease>
  >()('specialist', ['specialist:marketplace-release-get', ELECTRON]),
  'specialist.inspectGitHubMarketplaceSource': callable<
    (request: InspectGitHubMarketplaceSourceRequest) => Promise<MarketplaceSourceCandidate>
  >()('specialist', ['specialist:marketplace-source-inspect-github', ELECTRON]),
  'specialist.installMarketplace': callable<
    (request: MarketplaceInstallRequest) => Promise<MarketplaceInstallResult>
  >()('specialist', ['specialist:marketplace-install', ELECTRON]),
  'specialist.installPackage': callable<
    (request: SpecialistPackageInstallRequest) => Promise<SpecialistPackageInstallResult>
  >()('specialist', ['specialist:package-install', ELECTRON]),
  'specialist.list': callable<() => Promise<SpecialistCatalogSnapshot>>()('specialist', [
    'specialist:list',
    ELECTRON
  ]),
  'specialist.listMarketplace': callable<
    (request?: ListMarketplaceRequest) => Promise<MarketplaceSnapshot>
  >()('specialist', ['specialist:marketplace-list', ELECTRON]),
  'specialist.onCatalogChanged': callable<(listener: () => void) => RemoveListener>()(
    'specialist',
    ['specialist:catalog-changed', ELECTRON_EVENT]
  ),
  'specialist.onHandoffLifecycleEvent': callable<
    (listener: AcpListener<CompletionHandoffLifecycleEvent>) => RemoveListener
  >()('specialist', ['specialist:handoff-lifecycle-changed', ELECTRON_EVENT]),
  'specialist.onMarketplaceDownloadProgress': callable<
    (listener: (progress: MarketplaceDownloadProgress) => void) => RemoveListener
  >()('specialist', ['specialist:marketplace-download-progress', ELECTRON_EVENT]),
  'specialist.onPendingSwitch': callable<
    (listener: AcpListener<PendingSwitchBroadcast>) => RemoveListener
  >()('specialist', ['specialist:pending-switch', ELECTRON_EVENT]),
  'specialist.prepareMarketplaceInstall': callable<
    (request: PrepareMarketplaceInstallRequest) => Promise<MarketplaceInstallPreview>
  >()('specialist', ['specialist:marketplace-install-prepare', ELECTRON]),
  'specialist.previewDelete': callable<
    (request: { id: string }) => Promise<SpecialistDeletePreview>
  >()('specialist', ['specialist:delete-preview', ELECTRON]),
  'specialist.previewExport': callable<
    (request: { specialistId: string }) => Promise<SpecialistExportPreview>
  >()('specialist', ['specialist:export-preview', ELECTRON]),
  'specialist.removeMarketplaceSource': callable<
    (request: RemoveMarketplaceSourceRequest) => Promise<void>
  >()('specialist', ['specialist:marketplace-source-remove', ELECTRON]),
  'specialist.resolveSessionSpecialist': callable<
    (request: ResolveSessionSpecialistRequest) => Promise<SessionSpecialistResolution>
  >()('specialist', ['specialist:resolve-session-specialist', ELECTRON]),
  'specialist.retryHandoff': callable<(request: CompletionHandoffCommand) => Promise<unknown>>()(
    'specialist',
    ['specialist:retry-handoff', ELECTRON]
  ),
  'specialist.savePackageReport': callable<
    (request: SpecialistPackageInstallRequest) => Promise<SpecialistPackageReportSaveResult>
  >()('specialist', ['specialist:package-report-save', ELECTRON]),
  'specialist.selectPackage': callable<
    () => Promise<{ cancelled: true } | SpecialistPackageCandidatePreview>
  >()('specialist', ['specialist:package-select', ELECTRON]),
  'specialist.setEnabled': callable<
    (request: SetSpecialistEnabledRequest) => Promise<SpecialistView>
  >()('specialist', ['specialist:set-enabled', ELECTRON]),
  'specialist.setSessionSpecialist': callable<
    (request: SetSessionSpecialistRequest) => Promise<SetSessionSpecialistResponse>
  >()('specialist', ['specialist:set-session-specialist', ELECTRON]),
  'specialist.update': callable<(request: UpdateSpecialistRequest) => Promise<SpecialistView>>()(
    'specialist',
    ['specialist:update', ELECTRON]
  ),
  'storage.acceptMissingDataRoot': callable<() => Promise<void>>()('storage', [
    'storage:accept-missing-data-root',
    LOCAL
  ]),
  'storage.ackDataRootHandoffFlush': callable<
    (response: SessionPersistenceFlushResponse) => Promise<void>
  >()('storage', ['storage:ack-data-root-handoff-flush', LOCAL]),
  'storage.cancelMigrate': callable<() => Promise<void>>()('storage', [
    'storage:cancel-migrate',
    LOCAL
  ]),
  'storage.commitAndRelaunch': callable<(parent: string) => Promise<MigrationOutcome>>()(
    'storage',
    ['storage:commit-and-relaunch', LOCAL, STORAGE_PARENT]
  ),
  'storage.detectActive': callable<() => Promise<ActiveSessionInfo[]>>()('storage', [
    'storage:detect-active'
  ]),
  'storage.discardMigratedCopy': callable<(parent: string) => Promise<DiscardMigratedCopyResult>>()(
    'storage',
    ['storage:discard-migrated-copy', LOCAL, STORAGE_PARENT]
  ),
  'storage.dismissLegacyMovePrompt': callable<() => Promise<void>>()('storage', [
    'storage:dismiss-legacy-move-prompt'
  ]),
  'storage.getStatus': callable<() => Promise<StorageStatus>>()('storage', ['storage:get-status']),
  'storage.getInfo': callable<() => Promise<StorageInfo>>()('storage', ['storage:get-info']),
  'storage.inspectDataRoot': callable<(parent: string) => Promise<DataRootInspection>>()(
    'storage',
    ['storage:inspect-data-root', LOCAL, STORAGE_PARENT]
  ),
  'storage.migrate': callable<(parent: string) => Promise<MigrationOutcome>>()('storage', [
    'storage:migrate',
    LOCAL,
    STORAGE_PARENT
  ]),
  'storage.onProgress': callable<(listener: AcpListener<MigrationProgress>) => RemoveListener>()(
    'storage',
    ['storage:migrate-progress', EVENT]
  ),
  'storage.pickDirectory': callable<() => Promise<string | null>>()('storage', [
    'storage:pick-directory',
    LOCAL
  ]),
  'storage.revealAppStorage': callable<() => Promise<RevealAppStorageResult>>()('storage', [
    'storage:reveal-app-storage',
    LOCAL
  ]),
  'storage.setDataRootAndRelaunch': callable<
    (parent: string, markOnboarding?: boolean) => Promise<DataRootValidationResult>
  >()('storage', ['storage:set-data-root-and-relaunch', LOCAL, STORAGE_ROOT]),
  'storage.validateDataRoot': callable<(parent: string) => Promise<DataRootValidationResult>>()(
    'storage',
    ['storage:validate-data-root', LOCAL, STORAGE_PARENT]
  ),
  'tags.create': callable<(request: CreateTagRequest) => Promise<TagSnapshot>>()('tags', [
    'tags:create',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'tags.delete': callable<(request: DeleteTagRequest) => Promise<TagSnapshot>>()('tags', [
    'tags:delete',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'tags.onChanged': callable<(listener: AcpListener<TagsChangedEvent>) => RemoveListener>()(
    'tags',
    ['tags:changed', EVENT]
  ),
  'tags.reorder': callable<(request: ReorderTagsRequest) => Promise<TagSnapshot>>()('tags', [
    'tags:reorder',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'tags.setAssignment': callable<(request: SetTagAssignmentRequest) => Promise<TagSnapshot>>()(
    'tags',
    ['tags:set-assignment', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'tags.snapshot': callable<() => Promise<TagSnapshot>>()('tags', [
    'tags:snapshot',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'tags.update': callable<(request: UpdateTagRequest) => Promise<TagSnapshot>>()('tags', [
    'tags:update',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'update.apply': callable<() => Promise<UpdateStatus>>()('update', ['update:apply', LOCAL]),
  'update.cancel': callable<() => Promise<UpdateStatus>>()('update', ['update:cancel', LOCAL]),
  'update.check': callable<() => Promise<UpdateStatus>>()('update', ['update:check']),
  'update.download': callable<() => Promise<UpdateStatus>>()('update', ['update:download', LOCAL]),
  'update.getAppInfo': callable<() => Promise<AppInfo>>()('update', ['update:get-app-info']),
  'update.getStatus': callable<() => Promise<UpdateStatus>>()('update', ['update:get-status']),
  'update.onProgress': callable<
    (listener: (progress: DownloadProgress) => void) => RemoveListener
  >()('update', ['update:progress', EVENT]),
  'update.onStatus': callable<(listener: (status: UpdateStatus) => void) => RemoveListener>()(
    'update',
    ['update:status', EVENT]
  ),
  'uploads.abortTransfer': callable<(request: UploadTransferRequest) => Promise<void>>()(
    'uploads',
    ['uploads:abort-transfer']
  ),
  'uploads.appendTransfer': callable<
    (request: AppendUploadTransferRequest) => Promise<UploadTransferStatus>
  >()('uploads', ['uploads:append-transfer']),
  'uploads.beginTransfer': callable<
    (request: BeginUploadTransferRequest) => Promise<UploadTransferStatus>
  >()('uploads', ['uploads:begin-transfer']),
  'uploads.claimLocalFile': callable<(request: UploadTransferRequest) => Promise<void>>()(
    'uploads',
    ['uploads:claim-local-file'],
    { optionalMember: true }
  ),
  'uploads.deleteUpload': callable<(request: DeleteUploadRequest) => Promise<void>>()('uploads', [
    'uploads:delete'
  ]),
  'uploads.finalizeSession': callable<
    (request: FinalizeUploadSessionRequest) => Promise<UploadedAttachment[]>
  >()('uploads', ['uploads:finalize-session', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'uploads.finishTransfer': callable<
    (request: UploadTransferRequest) => Promise<UploadedAttachment>
  >()('uploads', ['uploads:finish-transfer']),
  'uploads.getTransferStatus': callable<
    (request: UploadTransferRequest) => Promise<UploadTransferStatus | null>
  >()('uploads', ['uploads:transfer-status']),
  'uploads.onTransferProgress': callable<
    (listener: AcpListener<UploadTransferProgress>) => RemoveListener
  >()('uploads', ['uploads:transfer-progress', ELECTRON_EVENT], { optionalMember: true }),
  'uploads.readPreview': callable<
    (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  >()('uploads', ['uploads:read-preview']),
  'uploads.stageLocalFile': callable<
    (file: File, request: BeginUploadTransferRequest) => Promise<UploadedAttachment | null>
  >()('uploads', ['uploads:stage-local-file', MAPPED_ELECTRON, NATIVE_FILE_UPLOAD], {
    optionalMember: true
  }),
  'uploads.stageLocalPath': callable<
    (request: StageLocalPathUploadRequest) => Promise<UploadedAttachment>
  >()('uploads', ['uploads:stage-local-path', LOCAL], { optionalMember: true }),
  'window.announceWindowFindAppearance': callable<(appearance: WindowFindAppearance) => void>()(
    'window',
    ['window:find-appearance-changed', SEND],
    { optionalMember: true }
  ),
  'window.announceWindowFindContentReady': callable<() => void>()(
    'window',
    ['shortcut:window-find-content-ready', SEND],
    { optionalMember: true }
  ),
  'window.announceWindowFindReady': callable<() => RemoveListener>()(
    'window',
    ['shortcut:window-find-ready', WINDOW_FIND_READY],
    { optionalMember: true }
  ),
  'window.clearFind': callable<() => void>()('window', ['window:clear-find-in-page', SEND], {
    optionalMember: true
  }),
  'window.close': callable<() => Promise<void>>()('window', ['window:close', MAPPED_NATIVE]),
  'window.closeFind': callable<() => void>()('window', ['window:find-close', SEND], {
    optionalMember: true
  }),
  'window.findInPage': callable<(request: WindowFindRequest) => void>()(
    'window',
    ['window:find-in-page', SEND],
    { optionalMember: true }
  ),
  'window.onCloseActivePane': callable<(listener: () => void) => RemoveListener>()(
    'window',
    ['shortcut:close-active-pane', CLOSE_PANE_EVENT],
    { optionalMember: true }
  ),
  'window.onCloseConfirmRequest': callable<
    (listener: (payload: CloseConfirmRequest) => void) => RemoveListener
  >()('window', ['window:close-confirm-request', ELECTRON_EVENT], { optionalMember: true }),
  'window.onFindInPageResult': callable<
    (listener: AcpListener<WindowFindResult>) => RemoveListener
  >()('window', ['window:find-in-page-result', ELECTRON_EVENT], { optionalMember: true }),
  'window.onHideWindowFind': callable<(listener: () => void) => RemoveListener>()(
    'window',
    ['window:find-hide', ELECTRON_EVENT],
    { optionalMember: true }
  ),
  'window.onShowWindowFind': callable<
    (listener: AcpListener<WindowFindAppearance>) => RemoveListener
  >()('window', ['window:find-show', ELECTRON_EVENT], { optionalMember: true }),
  'window.onWindowFindAppearance': callable<
    (listener: AcpListener<WindowFindAppearance>) => RemoveListener
  >()('window', ['window:find-appearance', ELECTRON_EVENT], { optionalMember: true }),
  'window.sendCloseConfirmResponse': callable<(payload: CloseConfirmResponse) => void>()(
    'window',
    ['window:close-confirm-response', SEND],
    { optionalMember: true }
  )
} as const)

export type OpenScienceAPI = RendererApiFromContract<typeof RENDERER_API_CONTRACT>

export type RendererApiContractPath = keyof typeof RENDERER_API_CONTRACT
export type RendererApiContractValue<Path extends RendererApiContractPath> = ContractValue<
  (typeof RENDERER_API_CONTRACT)[Path]
>

const RENDERER_CONTRACTS_IN_REGISTRATION_ORDER = Object.freeze(
  Object.entries(RENDERER_API_CONTRACT).flatMap(([publicPath, draft]) =>
    draft.metadata === null ? [] : [Object.freeze(expandEntry(publicPath, draft))]
  )
)

export const RENDERER_CONTRACT_CATALOG = Object.freeze(
  [...RENDERER_CONTRACTS_IN_REGISTRATION_ORDER].sort((left, right) =>
    left.publicPath.localeCompare(right.publicPath)
  )
)

const contractsByCapability = new Map<string, (typeof RENDERER_CONTRACT_CATALOG)[number][]>()
for (const contract of RENDERER_CONTRACTS_IN_REGISTRATION_ORDER) {
  const contracts = contractsByCapability.get(contract.capability) ?? []
  contracts.push(contract)
  contractsByCapability.set(contract.capability, contracts)
}

const RENDERER_CAPABILITY_ORDER = Object.freeze([
  'acp',
  'artifacts',
  'cli',
  'compute',
  'database-startup',
  'diagnostics',
  'github',
  'handoff',
  'lifecycle',
  'locale',
  'local-fs',
  'memory',
  'logs',
  'managed-file-versions',
  'network',
  'notebook',
  'notebook-environment',
  'notifications',
  'office-preview',
  'source-preview',
  'permissions',
  'platform-file-save',
  'preview',
  'preview-context-menu',
  'preview-resources',
  'project-files',
  'projects',
  'tags',
  'remote-access',
  'reviewer',
  'runtime',
  'sessions',
  'settings',
  'side-chat',
  'specialist',
  'storage',
  'update',
  'uploads',
  'window'
] as const)

export const RENDERER_CONTRACT_GROUPS: readonly RendererContractGroup[] = Object.freeze(
  RENDERER_CAPABILITY_ORDER.map((capability) => {
    const contracts = contractsByCapability.get(capability)
    if (!contracts) throw new Error(`Renderer contract capability is empty: ${capability}`)
    return defineRendererContractGroup(capability, contracts)
  })
)

export const ELECTRON_APPLICATION_COMMAND_CHANNELS: readonly string[] = Object.freeze(
  RENDERER_CONTRACT_CATALOG.flatMap(
    ({ applicationCommand, channel, dispatchPolicy, kind, surfaceInstallation }) =>
      applicationCommand === 'runtime-validated' &&
      channel !== null &&
      kind === 'method' &&
      surfaceInstallation.electron === 'preload' &&
      dispatchPolicy.electron === 'electron-ipc-request'
        ? [channel]
        : []
  ).sort()
)
