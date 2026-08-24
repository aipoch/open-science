import type { ClientConnection } from '@agentclientprotocol/sdk'

import { DEFAULT_UPLOAD_PROJECT_ID } from '../../shared/uploads'
import type { AgentFramework } from '../agent-framework'
import { AcpProviderSessionAdopter } from './provider-session-adopter'
import { AcpProviderSessionCreator } from './provider-session-creator'
import { AcpProviderSessionResumer } from './provider-session-resumer'
import type { AcpRuntimeOptions } from './runtime'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeLifecycleOwners } from './runtime-lifecycle-composition'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'
import { AcpSessionDeletionWorkflow } from './session-deletion-workflow'
import { AcpSessionReplacementWorkflow } from './session-replacement-workflow'
import type { AcpPrimarySessionIdentityReservation } from './session-registry'
import { CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY } from './session-capability-owner'

// Composes the five workflows that create, adopt, replace, delete, and resume Provider Sessions.
// Stable app identity remains Registry-owned; operation admission and timeout teardown derive from
// the completed lifecycle graph so no callback can observe a partially constructed Runtime.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimeProviderSessionOwners = (
  options: AcpRuntimeOptions,
  base: AcpRuntimeBaseOwners,
  session: AcpRuntimeSessionOwners,
  lifecycle: AcpRuntimeLifecycleOwners,
  runtime: Readonly<{
    clearUserChoiceProvenanceForSession: (sessionId: string) => void
  }>
) => {
  const currentConnection = (): ClientConnection | undefined => base.connectionResources.connection
  const currentFramework = (): AgentFramework => base.backendGeneration.current.framework
  const ensureConnected = (cwd: string): Promise<ClientConnection> =>
    lifecycle.connectionLifecycle.ensureConnected(cwd)
  const assertCurrentConnection = (connection: ClientConnection): void => {
    if (currentConnection() !== connection || base.snapshotOwner.status !== 'connected') {
      throw new Error('ACP session startup was superseded.')
    }
  }
  const diagnosticContext = () => ({
    framework: currentFramework().id,
    generation: base.connectionResources.epoch,
    status: base.snapshotOwner.status
  })
  const reserveIdentity = (
    reservation: AcpPrimarySessionIdentityReservation | undefined,
    sessionIds: string[],
    publishedAppSessionId?: string,
    startupGeneration = session.sessionRegistry.startupGeneration
  ) =>
    session.sessionRegistry.reserve({
      reservation,
      sessionIds,
      publishedAppSessionId,
      startupGeneration,
      mayRenewAfterConnectionSetup: Boolean(
        base.connectionTransitions.barrier ||
        !currentConnection() ||
        base.snapshotOwner.status !== 'connected'
      ),
      blockStartup: !base.connectionTransitions.barrier
    })
  const defaultProjectId = options.artifacts?.projectId || DEFAULT_UPLOAD_PROJECT_ID
  const updateCwd = (cwd: string): void => base.snapshotOwner.updateCwd(cwd)
  const emitState = (): void => session.publication.emitState()
  const withOperation = <Result>(work: () => Promise<Result>): Promise<Result> => {
    const barrier = lifecycle.modelChanges.barrier ?? base.connectionTransitions.barrier
    if (barrier) return barrier.then(() => withOperation(work))
    return base.generationActivity.withOperation(work)
  }
  const capabilityPolicy =
    options.sessionCapabilityPolicy ?? CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY

  const providerSessionCreator = new AcpProviderSessionCreator({
    defaultCwd: options.defaultCwd,
    defaultProjectId,
    currentCwd: () => base.snapshotOwner.cwd,
    ensureConnected,
    assertCurrentConnection,
    currentBackend: () => base.backendGeneration.current,
    registry: session.sessionRegistry,
    reserveIdentity: (sessionId, startupGeneration) =>
      reserveIdentity(undefined, [sessionId], undefined, startupGeneration),
    capabilities: base.sessionCapabilities,
    capabilityPolicy,
    configurator: base.sessionConfigurator,
    resolveSpecialistIdentity: options.resolveSpecialistIdentity,
    resolveSpecialistSkills: options.resolveSpecialistSkills,
    resolveProjectAgentContext: options.resolveProjectAgentContext,
    registerSessionSpecialist: options.notebook?.registerSessionSpecialist,
    updateCwd,
    pushEvent: (event) => session.publication.pushEvent(event),
    emitState,
    diagnosticContext
  })
  const providerSessionAdopter = new AcpProviderSessionAdopter({
    currentBackend: () => base.backendGeneration.current,
    registry: session.sessionRegistry,
    reserveIdentity: (reservation, sessionIds) => reserveIdentity(reservation, sessionIds),
    capabilities: base.sessionCapabilities,
    capabilityPolicy,
    configurator: base.sessionConfigurator,
    resolveSpecialistIdentity: options.resolveSpecialistIdentity,
    resolveSpecialistSkills: options.resolveSpecialistSkills,
    resolveProjectAgentContext: options.resolveProjectAgentContext,
    peekClaudeReplay: (sessionId) => base.handoffContinuity.peekClaudeReplay(sessionId),
    commitClaudeReplay: (sessionId) => base.handoffContinuity.commitClaudeReplay(sessionId),
    updateCwd,
    emitState,
    diagnosticContext
  })
  const sessionReplacement = new AcpSessionReplacementWorkflow({
    defaultCwd: options.defaultCwd,
    defaultProjectId,
    currentCwd: () => base.snapshotOwner.cwd,
    currentFrameworkId: () => currentFramework().id,
    ensureConnected,
    assertCurrentConnection,
    registry: session.sessionRegistry,
    reserveIdentity: (sessionId, publishedAppSessionId) =>
      reserveIdentity(undefined, [sessionId], publishedAppSessionId),
    adopter: providerSessionAdopter,
    permission: session.permissionContext,
    elicitation: session.elicitationOwner,
    clearUserChoiceProvenanceForSession: runtime.clearUserChoiceProvenanceForSession,
    appContinuations: session.appContinuations,
    promptContent: base.promptContentOwner,
    contextUsage: base.contextUsageTracker,
    interactions: base.sessionInteractions,
    resolveSpecialistIdentity: options.resolveSpecialistIdentity,
    registerSessionSpecialist: options.notebook?.registerSessionSpecialist
  })
  const sessionDeletion = new AcpSessionDeletionWorkflow({
    registry: session.sessionRegistry,
    withOperation,
    currentConnection,
    supportsSessionDelete: () => base.connectionResources.capabilities.delete,
    supportsSessionClose: () => base.connectionResources.capabilities.close,
    permission: session.permissionContext,
    elicitation: session.elicitationOwner,
    clearUserChoiceProvenanceForSession: runtime.clearUserChoiceProvenanceForSession,
    appContinuations: session.appContinuations,
    interactions: base.sessionInteractions,
    capabilities: base.sessionCapabilities,
    promptContent: base.promptContentOwner,
    handoff: base.handoffContinuity,
    contextUsage: base.contextUsageTracker,
    projector: session.sessionUpdateProjector,
    pushEvent: (event) => session.publication.pushEvent(event),
    emitState,
    getSnapshot: () => session.publication.getSnapshot()
  })
  const providerSessionResumer = new AcpProviderSessionResumer({
    defaultCwd: options.defaultCwd,
    defaultProjectId,
    currentCwd: () => base.snapshotOwner.cwd,
    currentConnection,
    ensureConnected,
    assertCurrentConnection,
    disconnectTimedOutConnection: async () => {
      await lifecycle.connectionClose.disconnect(false)
    },
    resumeCapabilityAdvertised: () => base.connectionResources.capabilities.resume,
    currentBackend: () => base.backendGeneration.current,
    registry: session.sessionRegistry,
    reserveIdentity: (sessionId) => reserveIdentity(undefined, [sessionId]),
    capabilities: base.sessionCapabilities,
    capabilityPolicy,
    configurator: base.sessionConfigurator,
    adopter: providerSessionAdopter,
    clearLivePermissionProfile: (sessionId) =>
      session.permissionContext.clearLivePermissionProfile(sessionId),
    resolveSpecialistIdentity: options.resolveSpecialistIdentity,
    resolveSpecialistSkills: options.resolveSpecialistSkills,
    resolveProjectAgentContext: options.resolveProjectAgentContext,
    updateCwd,
    pushEvent: (event) => session.publication.pushEvent(event),
    emitState,
    resumeTimeoutMs: options.resumeTimeoutMs ?? 5 * 60_000,
    setTimer: base.setTimer,
    clearTimer: base.clearTimer,
    diagnosticContext
  })

  return Object.freeze({
    providerSessionCreator,
    providerSessionResumer,
    sessionReplacement,
    sessionDeletion
  })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimeProviderSessionOwners = ReturnType<typeof composeAcpRuntimeProviderSessionOwners>

export { composeAcpRuntimeProviderSessionOwners }
export type { AcpRuntimeProviderSessionOwners }
