import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'

import {
  createIpcHandlerInstallationScope,
  ipcMainHandle,
  type IpcHandlerInstallation
} from '../ipc-handler-registry'

import type {
  AcpCancelPromptRequest,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpRuntimeEvent,
  AcpDeleteSessionRequest,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import { DEFAULT_ARTIFACT_PROJECT_NAME } from '../../shared/artifacts'
import { AcpRuntime, type AcpRuntimeCallbacks } from './runtime'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { installAgentShutdownGuard } from './shutdown-guard'
import { AgentMcpHttpHost } from './mcp-http-host'
import { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import {
  runTaskNotificationInBackground,
  type TaskNotificationService
} from '../notifications/task-notifications'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRunRepository } from '../notebook/repository'
import {
  NotebookRuntimeService,
  type NotebookRuntimeServiceOptions
} from '../notebook/runtime-service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { SettingsService } from '../settings/service'
import type { UploadRepository } from '../uploads/repository'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { projectRegistrySessionGrants } from './permission-broker'
import { broadcastToRenderers } from '../renderer-broadcast'
import { withDataRootWrite } from '../storage/migration-state'
import { createLogger, errorLogFields } from '../logger'
import type { ProfileService } from '../specialist/service'
import {
  buildSpecialistIdentityAppend,
  buildSpecialistIdentityPrefix
} from '../specialist/identity'
import {
  resolveEffectiveSpecialistSkills,
  filterSpecialistConnectorSkills
} from '../../shared/specialist'

const log = createLogger('acp')

type AcpIpcArtifacts = {
  repository: ArtifactRepository
  runRegistry: ArtifactRunRegistry
  provenanceRepository?: Pick<
    ArtifactProvenanceRepository,
    'listRunVersions' | 'writeAppGeneratedVersion'
  > &
    Partial<Pick<ArtifactProvenanceRepository, 'resolveVersionContent'>>
}

type AcpIpcOptions = AcpIpcArtifacts & {
  mcpEntryPath: string
  uploadRepository: UploadRepository
  notebookRpcServer: NotebookLocalRpcServer
  authorizeSkillImportReferencedUploads: (
    projectId: string,
    sessionId: string,
    paths: string[]
  ) => Promise<() => void>
  // Drives the agent spawn env from the active provider so switching takes effect on reconnect.
  settingsService: SettingsService
  permissionGrantRegistry?: PermissionGrantRegistry
  initializationBarrier?: Promise<unknown>
  // Observes prompt starts and terminal turn events for desktop notifications. Optional so tests
  // and headless setups can run without a notification surface.
  taskNotifications?: TaskNotificationService
  onSessionTurnStarted?: (sessionId: string, turnToken: string) => void
  onSessionTurnEnded?: (sessionId: string, turnToken: string) => void
  onSkillImportAttachmentEligible?: (
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ) => void
  onSessionCancellationRequested?: (sessionId: string) => void
  onSessionUnavailable?: (sessionId: string) => void
  onAllSessionsCancellationRequested?: () => void
  beforeSessionDelete?: (sessionId: string) => Promise<void>
  // Provides fresh Specialist Profiles for first-turn identity injection. Optional so existing
  // tests and headless setups that construct the runtime without specialist support are unaffected.
  profileService?: ProfileService
}

// Sends one runtime payload through the typed application-event compatibility facade.
const broadcast = broadcastToRenderers

// Gives every new conversation an isolated working directory under the relocatable data root.
// Persisted sessions keep this returned path as their cwd, so resumes return to the same workspace.
const createManagedSessionWorkspace = async (): Promise<string> => {
  const workspace = join(resolveDataRoot(), 'workspaces', randomUUID())

  await mkdir(workspace, { recursive: true })
  return workspace
}

// Creates the runtime coordinator used by all ACP IPC handlers and artifact claims. Each child runtime
// captures one framework generation so sessions on different frameworks can remain live concurrently.
const createAcpRuntime = ({
  mcpEntryPath,
  repository,
  runRegistry,
  provenanceRepository,
  uploadRepository,
  notebookRpcServer,
  authorizeSkillImportReferencedUploads,
  settingsService,
  permissionGrantRegistry,
  initializationBarrier,
  taskNotifications,
  onSessionTurnStarted,
  onSessionTurnEnded,
  onSkillImportAttachmentEligible,
  onSessionCancellationRequested,
  onSessionUnavailable,
  onAllSessionsCancellationRequested,
  beforeSessionDelete,
  profileService
}: AcpIpcOptions): AcpRuntimeCoordinator => {
  const configRoot = resolveConfigRoot()
  const dataRoot = resolveDataRoot()
  const defaultCwd = homedir()
  const callbacks: AcpRuntimeCallbacks = {
    onStateChanged: (state: AcpStateSnapshot) => broadcast('acp:state', state),
    onEvent: (event: AcpRuntimeEvent) => {
      broadcast('acp:event', event)
      // Fire-and-forget: a notification hiccup must never stall the renderer event stream.
      if (taskNotifications) {
        runTaskNotificationInBackground(
          () => taskNotifications.handleRuntimeEvent(event),
          (error) => log.warn('task notification event failed', errorLogFields(error))
        )
      }
    },
    onPermissionRequest: (request: AcpPermissionRequest) => {
      broadcast('acp:permission-request', request)
      // A pending approval parks the turn; an unfocused user gets a desktop nudge.
      if (taskNotifications) {
        runTaskNotificationInBackground(
          () => taskNotifications.handlePermissionRequest(request),
          (error) => log.warn('permission notification failed', errorLogFields(error))
        )
      }
    }
  }

  return new AcpRuntimeCoordinator(
    (runtimeCallbacks, permissionGrantStore) => {
      // Capture only the non-secret selection per generation. Credentials are resolved fresh at spawn
      // and released by AcpRuntime after authentication instead of living in this coordinator closure.
      const selection = settingsService.captureActiveAgentBackendSelection()
      return new AcpRuntime({
        appVersion: app.getVersion(),
        // Packaged macOS apps often start with cwd at "/" or the app bundle; use home instead.
        defaultCwd,
        resolveBackend: async (context) =>
          settingsService.resolveAgentBackend(await selection, context),
        // HTTP MCP registrations are runtime-owned. Sharing one host would let an old runtime teardown
        // clear routes belonging to sessions on the newly selected framework.
        mcpHttpHost: new AgentMcpHttpHost(),
        skills: {
          needForceLoad: (ids) => settingsService.skillsNeedingForceLoad(ids),
          namesForIds: (ids) => settingsService.skillNudgeNamesForIds(ids),
          descriptorsForIds: (ids, codexHome) =>
            settingsService.codexSkillDescriptorsForIds(ids, codexHome),
          catalogForCodexHome: (codexHome) => settingsService.codexSkillCatalog(codexHome)
        },
        artifacts: {
          configRoot,
          dataRoot,
          projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
          mcpEntryPath,
          repository,
          runRegistry,
          provenance: provenanceRepository,
          getRpcConnection: () => notebookRpcServer.ensureStarted(),
          issueRpcCapability: (binding) => notebookRpcServer.issueArtifactRunCapability(binding),
          revokeRpcCapability: (token) => notebookRpcServer.revokeArtifactRunCapability(token)
        },
        uploads: { repository: uploadRepository },
        notebook: {
          projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
          mcpEntryPath,
          getRpcConnection: ({ sessionId, projectId }) =>
            notebookRpcServer.issueSessionConnection(sessionId, projectId),
          registerSessionAlias: (aliasSessionId, sessionId) =>
            notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
          releaseSessionCapabilities: (sessionId) =>
            notebookRpcServer.releaseSessionCapabilities(sessionId),
          registerSessionSpecialist: (sessionId, specialistId) =>
            notebookRpcServer.registerSessionSpecialist(sessionId, specialistId),
          setArtifactProvenanceContext: (sessionId, context) =>
            notebookRpcServer.setArtifactProvenanceContext(sessionId, context),
          registerTurnInputs: (request) => notebookRpcServer.registerNotebookTurnInputs(request)
        },
        skillImport: {
          mcpEntryPath,
          isEnabled: () => settingsService.getConversationSkillImportEnabled(),
          getRpcConnection: () => notebookRpcServer.ensureStarted(),
          registerSessionAlias: (aliasSessionId, sessionId) =>
            notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
          authorizeReferencedUploads: authorizeSkillImportReferencedUploads
        },
        activityGroups: { mcpEntryPath },
        callbacks: runtimeCallbacks,
        permissionGrantStore,
        permissionGrantRegistry,
        // Main process resolves the latest Profile so the renderer never needs to send systemPrompt.
        resolveSpecialistIdentity: profileService
          ? async (specialistId: string, frameworkId: string) => {
              let profile
              try {
                profile = await profileService.getById(specialistId)
              } catch {
                // Profile not found or corrupt
                return undefined
              }
              if (!profile.enabled) return undefined
              const append = buildSpecialistIdentityAppend(profile)
              const prefix = buildSpecialistIdentityPrefix(profile)
              // For Claude, only the append matters (session-level meta).
              // For Codex/OpenCode, only the prefix matters (per-turn).
              // Return both so the runtime can choose by framework.
              if (frameworkId === 'claude-code') return { append, prefix: '' }
              return { append: '', prefix }
            }
          : undefined,
        resolveSpecialistSkills: profileService
          ? async (specialistId) => {
              try {
                const profile = await profileService.getById(specialistId)
                if (!profile.enabled) {
                  return { kind: 'unavailable', reason: 'The bound specialist is disabled.' }
                }
                const effective = resolveEffectiveSpecialistSkills(
                  profile,
                  await settingsService.listSpecialistSkillCatalog()
                )
                if (effective.kind === 'specialist') {
                  // Connector tools are delivered as mcp-<id> skills on disk. Claude's options.skills
                  // whitelist is restrictive, so without these names the agent cannot load the connector
                  // skill docs and never discovers the tools. Include only the connectors this specialist
                  // is allowed to use (selectedCapabilities.connectorIds, or all minus full-access
                  // exclusions) so discovery matches the capability scope; the per-call ConnectorService
                  // gate still enforces the same config at call time.
                  const provisioned = await settingsService.provisionedConnectorSkillNames()
                  const connectorSkills = filterSpecialistConnectorSkills(provisioned, profile)
                  if (connectorSkills.length > 0) {
                    return {
                      ...effective,
                      frameworkNames: [...effective.frameworkNames, ...connectorSkills]
                    }
                  }
                }
                return effective
              } catch {
                return { kind: 'unavailable', reason: 'The bound specialist is unavailable.' }
              }
            }
          : undefined
      })
    },
    callbacks,
    defaultCwd,
    initializationBarrier,
    undefined,
    onSessionUnavailable,
    {
      onSessionTurnStarted,
      onSessionTurnEnded,
      onSkillImportAttachmentEligible,
      onSessionCancellationRequested,
      onAllSessionsCancellationRequested,
      beforeSessionDelete
    },
    permissionGrantRegistry
      ? () => projectRegistrySessionGrants(permissionGrantRegistry.listCached())
      : undefined
  )
}

const registerAcpIpcHandlerSet = (
  runtime: AcpRuntimeCoordinator,
  taskNotifications?: TaskNotificationService
): void => {
  ipcMainHandle('acp:get-state', () => runtime.getSnapshot())
  ipcMainHandle('acp:connect', (_event, request: AcpConnectRequest) => runtime.connect(request))
  ipcMainHandle('acp:disconnect', () => runtime.disconnect())
  ipcMainHandle('acp:create-session', async (_event, request: AcpCreateSessionRequest) => {
    try {
      const explicitCwd = request.cwd?.trim()
      if (explicitCwd) {
        return await runtime.createSession({ ...request, cwd: explicitCwd })
      }

      return await withDataRootWrite(async () => {
        const managedCwd = await createManagedSessionWorkspace()
        try {
          return await runtime.createSession({ ...request, cwd: managedCwd })
        } catch (error) {
          await rm(managedCwd, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
      })
    } catch (error) {
      // Route through the file logger (rotating main.log) so the failure survives in a packaged build,
      // not just the dev console. errorLogFields keeps the message + stack out of a `{}`. Guarded so a
      // throwing logger can never mask the original error the renderer must still receive.
      try {
        log.error('acp:create-session failed', errorLogFields(error))
      } catch {
        /* logging must never mask the real error */
      }
      throw error
    }
  })
  ipcMainHandle('acp:resume-session', (_event, request: AcpResumeSessionRequest) =>
    runtime.resumeSession(request)
  )
  ipcMainHandle('acp:reset-session-context', (_event, request: AcpResumeSessionRequest) =>
    runtime.resetSessionContext(request)
  )
  ipcMainHandle('acp:compact-session', (_event, request: AcpCompactSessionRequest) =>
    runtime.compactSession(request)
  )
  // Prompt calls wait for the turn to stop, then return the latest snapshot.
  ipcMainHandle('acp:send-prompt', async (_event, request: AcpPromptRequest) => {
    // Remember the prompt's first line so a completion/failure notification can name the task.
    // If the runtime rejects before the turn starts (unknown session, another prompt in flight),
    // revert so a still-running turn keeps its own prompt's name.
    const tracked = taskNotifications?.trackPrompt(request)

    try {
      await runtime.sendPrompt(request)
    } catch (error) {
      if (tracked) taskNotifications?.untrackPrompt(request.sessionId, tracked)
      throw error
    }

    return runtime.getSnapshot()
  })
  ipcMainHandle('acp:cancel', (_event, request: AcpCancelPromptRequest) =>
    runtime.cancelPrompt(request)
  )
  ipcMainHandle('acp:delete-session', async (_event, request: AcpDeleteSessionRequest) => {
    // The coordinator owns session disappearance notifications for delete, connection loss, and
    // retirement. Keeping that signal in one layer prevents a successful delete from firing twice.
    return runtime.deleteSession(request)
  })
  ipcMainHandle('acp:respond-permission', (_event, response: AcpPermissionResponse) =>
    runtime.respondToPermission(response)
  )
  ipcMainHandle('acp:set-permission-profile', (_event, request: AcpSetPermissionProfileRequest) =>
    runtime.setPermissionProfile(request)
  )
  ipcMainHandle('acp:revoke-permission-grant', (_event, request: AcpRevokePermissionGrantRequest) =>
    runtime.revokePermissionGrant(request)
  )
}

// Installs the renderer-callable Electron adapter over an already-constructed ACP coordinator.
const installAcpIpcHandlers = (
  runtime: AcpRuntimeCoordinator,
  taskNotifications?: TaskNotificationService
): IpcHandlerInstallation => {
  const scope = createIpcHandlerInstallationScope()
  try {
    registerAcpIpcHandlerSet(runtime, taskNotifications)
    // Kill the agent child on quit so it never outlives the app as an orphaned process.
    return scope.complete(installAgentShutdownGuard(app, runtime))
  } catch (error) {
    scope.rollback()
    throw error
  }
}

// Compatibility wrapper for isolated callers; application composition uses the two-phase seam above.
const registerAcpIpcHandlers = (options: AcpIpcOptions): AcpRuntimeCoordinator => {
  const runtime = createAcpRuntime(options)
  installAcpIpcHandlers(runtime, options.taskNotifications)
  return runtime
}

// Creates the shared notebook runtime used by both renderer IPC and agent MCP calls.
type DefaultNotebookRuntimeServiceDeps = Pick<
  NotebookRuntimeServiceOptions,
  'getPackageMirror' | 'getRuntimeEnablement' | 'getManualInterpreters'
>

const createDefaultNotebookRuntimeService = (
  deps: DefaultNotebookRuntimeServiceDeps = {}
): NotebookRuntimeService => {
  const dataRoot = resolveDataRoot()
  const artifactRepository = new ArtifactRepository(dataRoot)

  return new NotebookRuntimeService({
    configRoot: resolveConfigRoot(),
    dataRoot,
    projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
    repository: new NotebookRunRepository(dataRoot),
    ...deps,
    // Region default for manage_packages when no mirror is configured.
    locale: app.getLocale(),
    appVersion: app.getVersion(),
    resolveArtifactPath: (request) =>
      artifactRepository.resolveSessionArtifactFilePath(
        request.projectName,
        request.sessionId,
        request.path
      ),
    callbacks: {
      onNotebookAvailable: (event) => broadcast('notebook:available', event),
      onNotebookChanged: (event) => broadcast('notebook:changed', event)
    }
  })
}

export {
  createAcpRuntime,
  createDefaultNotebookRuntimeService,
  installAcpIpcHandlers,
  registerAcpIpcHandlers
}
export type { AcpIpcOptions }
