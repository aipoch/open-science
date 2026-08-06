import { homedir } from 'node:os'

import { app } from 'electron'

import type { AcpPermissionRequest, AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import { DEFAULT_ARTIFACT_PROJECT_NAME } from '../../shared/artifacts'
import {
  filterSpecialistConnectorSkills,
  resolveEffectiveSpecialistSkills
} from '../../shared/specialist'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import { createLogger, errorLogFields } from '../logger'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import {
  runTaskNotificationInBackground,
  type TaskNotificationService
} from '../notifications/task-notifications'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { AcpSettingsCapabilities } from '../settings/service-capabilities'
import {
  buildSpecialistIdentityAppend,
  buildSpecialistIdentityPrefix
} from '../specialist/identity'
import type { ProfileService } from '../specialist/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { UploadRepository } from '../uploads/repository'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { AgentMcpHttpHost } from './mcp-http-host'
import { projectRegistrySessionGrants } from './permission-broker'
import { AcpRuntime, type AcpRuntimeCallbacks, type AcpRuntimeOptions } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

const log = createLogger('acp')

type AcpRuntimeArtifacts = {
  repository: ArtifactRepository
  runRegistry: ArtifactRunRegistry
  provenanceRepository?: Pick<
    ArtifactProvenanceRepository,
    'listRunVersions' | 'writeAppGeneratedVersion'
  > &
    Partial<Pick<ArtifactProvenanceRepository, 'resolveVersionContent'>>
}

type AcpRuntimeCompositionOptions = AcpRuntimeArtifacts & {
  mcpEntryPath: string
  uploadRepository: UploadRepository
  notebookRpcServer: NotebookLocalRpcServer
  peekNotebookHandoffContext?: (sessionId: string) => NotebookHandoffContext | undefined
  authorizeSkillImportReferencedUploads: (
    projectId: string,
    sessionId: string,
    paths: string[]
  ) => Promise<() => void>
  settingsService: AcpSettingsCapabilities
  permissionGrantRegistry?: PermissionGrantRegistry
  initializationBarrier?: Promise<unknown>
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
  onDisconnected?: () => void
  beforeSessionDelete?: (sessionId: string) => Promise<void>
  profileService?: ProfileService
  sessionPersistenceCoordinator?: Pick<
    SessionPersistenceCoordinator,
    | 'readSessionRuntimeContext'
    | 'patchSessionRuntimeContext'
    | 'appendUserMessageToInteraction'
    | 'containsMessageOnActiveBranch'
  >
}

// Composes the compatibility façade while the coordinator remains the cross-generation Session owner.
const createAcpRuntime = ({
  mcpEntryPath,
  repository,
  runRegistry,
  provenanceRepository,
  uploadRepository,
  notebookRpcServer,
  peekNotebookHandoffContext,
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
  onDisconnected,
  beforeSessionDelete,
  profileService,
  sessionPersistenceCoordinator
}: AcpRuntimeCompositionOptions): AcpRuntimeCoordinator => {
  const configRoot = resolveConfigRoot()
  const dataRoot = resolveDataRoot()
  const defaultCwd = homedir()
  const callbacks: AcpRuntimeCallbacks = {
    onStateChanged: (state: AcpStateSnapshot) => broadcastToRenderers('acp:state', state),
    onEvent: (event: AcpRuntimeEvent) => {
      broadcastToRenderers('acp:event', event)
      // Fire-and-forget: a notification hiccup must never stall the renderer event stream.
      if (taskNotifications) {
        runTaskNotificationInBackground(
          () => taskNotifications.handleRuntimeEvent(event),
          (error) => log.warn('task notification event failed', errorLogFields(error))
        )
      }
    },
    onPermissionRequest: (request: AcpPermissionRequest) => {
      broadcastToRenderers('acp:permission-request', request)
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
      const selection = settingsService.captureActiveAgentBackendSelection()
      const runtimeOptions: AcpRuntimeOptions = {
        appVersion: app.getVersion(),
        // Packaged macOS apps often start with cwd at "/" or the app bundle; use home instead.
        defaultCwd,
        resolveBackend: async (context) =>
          settingsService.resolveAgentBackend(await selection, context),
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
          registerTurnInputs: (request) => notebookRpcServer.registerNotebookTurnInputs(request),
          peekHandoffContext: peekNotebookHandoffContext
        },
        skillImport: {
          mcpEntryPath,
          isEnabled: () => settingsService.getConversationSkillImportEnabled(),
          getRpcConnection: ({ sessionId }) =>
            notebookRpcServer.issueSkillImportConnection(sessionId),
          registerSessionAlias: (aliasSessionId, sessionId) =>
            notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
          releaseSessionCapabilities: (sessionId) =>
            notebookRpcServer.releaseSessionCapabilities(sessionId),
          authorizeReferencedUploads: authorizeSkillImportReferencedUploads
        },
        ...(sessionPersistenceCoordinator
          ? {
              plan: {
                mcpEntryPath,
                getRpcConnection: ({ sessionId, projectId }) =>
                  notebookRpcServer.issuePlanConnection(sessionId, projectId),
                registerSessionAlias: (aliasSessionId, sessionId) =>
                  notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
                sessions: sessionPersistenceCoordinator
              }
            }
          : {}),
        callbacks: runtimeCallbacks,
        permissionGrantStore,
        permissionGrantRegistry,
        resolveSpecialistIdentity: profileService
          ? async (specialistId: string, frameworkId: string) => {
              let profile
              try {
                profile = await profileService.resolveRunnableById(specialistId)
              } catch {
                // Profile not found or corrupt
                return undefined
              }
              if (!profile.enabled) return undefined
              const append = buildSpecialistIdentityAppend(profile)
              const prefix = buildSpecialistIdentityPrefix(profile)
              if (frameworkId === 'claude-code') return { append, prefix: '' }
              return { append: '', prefix }
            }
          : undefined,
        resolveSpecialistSkills: profileService
          ? async (specialistId) => {
              try {
                const profile = await profileService.resolveRunnableById(specialistId)
                if (!profile.enabled) {
                  return { kind: 'unavailable', reason: 'The bound specialist is disabled.' }
                }
                const effective = resolveEffectiveSpecialistSkills(
                  profile,
                  await settingsService.listSpecialistSkillCatalog()
                )
                if (effective.kind === 'specialist') {
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
      }
      const baseOwners = composeAcpRuntimeBaseOwners(runtimeOptions)
      return new AcpRuntime(
        runtimeOptions,
        baseOwners,
        composeAcpRuntimeSessionOwners(runtimeOptions, baseOwners)
      )
    },
    callbacks,
    defaultCwd,
    initializationBarrier,
    onDisconnected,
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

export { createAcpRuntime }
export type { AcpRuntimeCompositionOptions }
