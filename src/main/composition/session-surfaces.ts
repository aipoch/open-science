import { app } from 'electron'
import {
  LIFECYCLE_CHANNELS,
  MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID
} from '../../shared/lifecycle-events'
import type { LoadAllSessionsResult } from '../../shared/session-persistence'
import { RestrictedInferenceRunner } from '../acp/restricted-inference-runner'
import { createAcpRuntime } from '../acp/runtime-composition'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ArtifactReproducibilityAttemptOwner } from '../artifacts/artifact-reproducibility-lifecycle'
import { createComputeIpcModule } from '../compute/ipc'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { createSpecialistElectronSurface } from '../ipc-surfaces/specialist'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import { buildSessionDetailsUserPrompt, createSessionDetailsOwner } from '../session-details/owner'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import {
  coordinateSessionPersistenceWithProjectDeletions,
  createDefaultReviewRepository,
  createSessionPersistenceHandlersWithAttributionAuthority,
  withSessionDeletionCleanup
} from '../session-persistence/ipc'
import { MainMessageAttributionAuthority } from '../session-persistence/message-attribution-authority'
import { SettingsService } from '../settings/service'
import { createSpecialistApplicationOwner } from '../specialist/application-commands'
import { MarketplaceService } from '../specialist/marketplace/service'
import { SpecialistPackageService } from '../specialist/package/service'
import { SpecialistService } from '../specialist/service'
import { SessionBindingService } from '../specialist/session-binding'
import { SessionSpecialistReconfiguration } from '../specialist/session-reconfiguration'
import { resolveConfigRoot } from '../storage-root'
import { createUploadCommandOwner } from '../uploads/command-owner'
import { WslSetupSessionOwner } from '../wsl/wsl-setup-session-owner'

export async function composeSessionSurfaces({
  surfaceAdapters,
  applicationEvents,
  wslSetupSessions,
  settingsService,
  messageAttributionAuthority,
  configRoot,
  artifactReproducibilityAttemptOwnerRef,
  sessionPersistenceCoordinator,
  uploadCommandOwner,
  reviewRepository,
  startupSessionDetails,
  sessionPersistenceBackend,
  specialistService,
  specialistPackageService,
  marketplaceService,
  sessionBindingService,
  sessionSpecialistReconfiguration,
  computeService,
  runtime,
  translate,
  modules,
  composition
}: {
  surfaceAdapters: import('../runtime-electron-wiring').NamedElectronSurfaceAdapter[]
  applicationEvents: ApplicationEvents
  wslSetupSessions: WslSetupSessionOwner
  settingsService: SettingsService
  messageAttributionAuthority: MainMessageAttributionAuthority
  configRoot: ReturnType<typeof resolveConfigRoot>
  artifactReproducibilityAttemptOwnerRef: {
    current?: ArtifactReproducibilityAttemptOwner
  }
  sessionPersistenceCoordinator: SessionPersistenceCommands
  uploadCommandOwner: ReturnType<typeof createUploadCommandOwner>
  reviewRepository: ReturnType<typeof createDefaultReviewRepository>
  startupSessionDetails: { current: LoadAllSessionsResult['sessions'] | undefined }
  sessionPersistenceBackend: ReturnType<typeof coordinateSessionPersistenceWithProjectDeletions>
  specialistService: SpecialistService
  specialistPackageService: SpecialistPackageService
  marketplaceService: MarketplaceService
  sessionBindingService: SessionBindingService
  sessionSpecialistReconfiguration: SessionSpecialistReconfiguration
  computeService: ReturnType<typeof createComputeIpcModule>['computeService']
  runtime: ReturnType<typeof createAcpRuntime>
  translate: import('../locale/main-process-messages').NativeTranslator
  modules: ApplicationModuleBuilder
  composition: DiagnosticOperation
}): Promise<{
  sessionPersistenceHandlers: ReturnType<
    typeof createSessionPersistenceHandlersWithAttributionAuthority
  >
  sessionDetailsOwner: ReturnType<typeof createSessionDetailsOwner>
  specialistApplicationOwner: ReturnType<typeof createSpecialistApplicationOwner>
}> {
  // Wire Session deletion to the binding stores so stale capabilities cannot reappear on restart.
  // The renderer calls sessions:delete-session (via sessionPersistenceBackend) and acp:delete-session
  // separately; both paths should clear the binding. Override the backend deleteSession callback here
  // so all durable-path deletions — regardless of whether the ACP session was attached — clear the
  // binding in one place.
  const originalDeleteSession =
    sessionPersistenceBackend.deleteSession.bind(sessionPersistenceBackend)
  const deleteSessionWithCleanup = withSessionDeletionCleanup(
    withSessionDeletionCleanup(originalDeleteSession, (_projectId, sessionId) =>
      sessionSpecialistReconfiguration.clearSession(sessionId)
    ),
    (_projectId, sessionId) => wslSetupSessions.forget(sessionId)
  )
  sessionPersistenceBackend.deleteSession = async (projectId, sessionId) => {
    const owner = artifactReproducibilityAttemptOwnerRef.current
    const operation = (): Promise<void> => deleteSessionWithCleanup(projectId, sessionId)
    if (owner) await owner.withSessionStopped(projectId, sessionId, operation)
    else await operation()
  }
  const sessionPersistenceHandlers = createSessionPersistenceHandlersWithAttributionAuthority(
    sessionPersistenceBackend,
    reviewRepository,
    messageAttributionAuthority,
    async () => {
      try {
        await computeService.startQueueReconciliation({ retryFailedOnly: true })
      } catch (error) {
        // Keep the catalog diagnostics and affected-file recovery UI readable while dispatch is blocked.
        createLogger('compute-integrity').warn(
          'Compute queue recovery remains blocked',
          errorLogFields(error)
        )
      }
    }
  )
  const sessionDetailsOwner = await modules.add(
    {
      appVersion: app.getVersion(),
      configRoot,
      settingsService,
      sessionPersistenceBackend,
      sessionPersistenceCoordinator
    },
    (dependencies) => {
      const log = createLogger('session-details')
      const inference = new RestrictedInferenceRunner({
        appVersion: dependencies.appVersion,
        configRoot: dependencies.configRoot,
        profileNamespace: 'session-details',
        resolveTarget: (target, context) =>
          dependencies.settingsService.resolveExplicitAgentBackend(target, context)
      })
      const owner = createSessionDetailsOwner({
        sessions: {
          listSessions: async () =>
            (await dependencies.sessionPersistenceBackend.loadAll()).sessions,
          mutateSession: (projectId, sessionId, mutation) =>
            dependencies.sessionPersistenceCoordinator.mutateSessionDetailsAuthority(
              projectId,
              sessionId,
              (session) => {
                const result = mutation(session)
                return result.kind === 'write' ? result.session : undefined
              }
            )
        },
        targets: {
          resolve: async (session) => {
            const admission =
              await dependencies.settingsService.admitSessionDetailsExecutionTarget(session)
            if (admission.mode === 'disabled') return { mode: 'disabled' }
            if (!inference.supportsTarget(admission.target)) return { mode: 'unavailable' }
            return {
              mode: 'admitted',
              frameworkId: admission.target.frameworkId,
              providerId: admission.target.providerId,
              model:
                admission.target.model.kind === 'required'
                  ? admission.target.model.id
                  : 'provider-default',
              reasoningEffort: admission.target.reasoningEffort
            }
          }
        },
        inference: {
          generate: async (request) => {
            if (!request.target.providerId) {
              throw new Error('Session details inference requires a provider target.')
            }
            const result = await inference.run({
              prompt: buildSessionDetailsUserPrompt(request.firstMessage),
              target: {
                frameworkId: request.target.frameworkId,
                providerId: request.target.providerId,
                model: { kind: 'required', id: request.target.model },
                reasoningEffort: request.target.reasoningEffort
              },
              systemPrompt: request.systemInstruction,
              agentName: 'Session details',
              description: 'Generate a Session title and description',
              signal: request.signal,
              outputLimitBytes: 8_192
            })
            return { output: result.text, usage: result.usage, stopReason: result.stopReason }
          }
        },
        lifecycle: {
          publish: (session) =>
            applicationEvents.publish(LIFECYCLE_CHANNELS.sessionUpdated, {
              session,
              originClientId: MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID
            })
        },
        log
      })
      return {
        name: 'session-details',
        capability: owner,
        start: async () => {
          await inference
            .sweepStaleProfiles()
            .catch((error) =>
              log.warn('stale Session details profile cleanup failed', diagnosticErrorFields(error))
            )
          composition.phase('session-details-recovery')
          const candidates = startupSessionDetails.current
          startupSessionDetails.current = undefined
          await owner.start(candidates)
          composition.phase('session-details-ready')
        },
        dispose: async () => {
          await owner.shutdown()
          await inference.shutdown()
        }
      }
    }
  )
  const specialistApplicationOwner = createSpecialistApplicationOwner({
    service: specialistService,
    packages: specialistPackageService,
    uploads: uploadCommandOwner,
    marketplace: marketplaceService,
    sessionReconfiguration: sessionSpecialistReconfiguration,
    onProfilesChanged: () => void runtime.requestSkillsReload()
  })
  specialistService.subscribe(() =>
    applicationEvents.publish('specialist:catalog-changed', undefined)
  )
  surfaceAdapters.push(
    createSpecialistElectronSurface({
      specialistService,
      sessionBindingService,
      sessionSpecialistReconfiguration,
      onProfilesChanged: () => void runtime.requestSkillsReload(),
      specialistPackageService,
      marketplaceService,
      specialistApplicationOwner,
      translate
    })
  )
  return { sessionPersistenceHandlers, sessionDetailsOwner, specialistApplicationOwner }
}
