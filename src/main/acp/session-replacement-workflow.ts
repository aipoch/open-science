import type { ClientConnection } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'

import type { AcpCreateSessionResponse, AcpResumeSessionRequest } from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AcpAppContinuationOwner } from './app-continuation-owner'
import type { ContextUsageTracker } from './context-usage-tracker'
import type { AcpElicitationOwner } from './elicitation-owner'
import type { AcpPermissionContext } from './permission-context'
import type { AcpPromptContentOwner } from './prompt-content-owner'
import type { AcpProviderSessionAdopter } from './provider-session-adopter'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import type {
  AcpPrimarySessionIdentityReservationResult,
  AcpSessionRegistry
} from './session-registry'

type AcpSessionReplacementWorkflowDependencies = Readonly<{
  defaultCwd: string
  defaultProjectId: string
  currentCwd: () => string | undefined
  currentFrameworkId: () => AgentFrameworkId
  ensureConnected: (cwd: string) => Promise<ClientConnection>
  assertCurrentConnection: (connection: ClientConnection) => void
  registry: Pick<AcpSessionRegistry, 'lookup' | 'detach' | 'ensureAffinity'>
  reserveIdentity: (
    sessionId: string,
    publishedAppSessionId?: string
  ) => AcpPrimarySessionIdentityReservationResult
  adopter: Pick<AcpProviderSessionAdopter, 'adopt'>
  permission: Pick<AcpPermissionContext, 'cancelForSession' | 'clearLivePermissionProfile'>
  elicitation: Pick<AcpElicitationOwner, 'cancelForSession'>
  clearUserChoiceProvenanceForSession: (sessionId: string) => void
  appContinuations: Pick<AcpAppContinuationOwner, 'delete'>
  promptContent: Pick<AcpPromptContentOwner, 'resetSession'>
  contextUsage: Pick<ContextUsageTracker, 'deleteSession'>
  interactions: Pick<AcpSessionInteractionOwner, 'current' | 'supersedeCurrent'>
  resolveSpecialistIdentity?: (
    specialistId: string,
    frameworkId: AgentFrameworkId
  ) => Promise<{ append: string; prefix: string } | undefined>
  registerSessionSpecialist?: (sessionId: string, specialistId: string | undefined) => void
}>

export class AcpSessionReplacementWorkflow {
  constructor(private readonly deps: AcpSessionReplacementWorkflowDependencies) {}

  // Coordinates owner cleanup without retaining Session facts; the Registry and each state owner
  // remain authoritative while the Adopter publishes the replacement provider Session.
  async reset(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    const cwd = resolve(request.cwd || this.deps.currentCwd() || this.deps.defaultCwd)
    const projectId = request.projectId?.trim() || this.deps.defaultProjectId
    const publishedSession = this.deps.registry.lookup(request.sessionId)?.attachment?.session
    const aggregate = this.deps.registry.lookup(request.sessionId)?.aggregate
    const previousMemoryEnabled = aggregate?.snapshot().memoryEnabled
    const reserved = this.deps.reserveIdentity(
      request.sessionId,
      publishedSession ? request.sessionId : undefined
    )
    if (reserved.collision) throw reserved.collision
    const identity = reserved.reservation
    aggregate?.setMemoryEnabled(request.memoryEnabled !== false)

    try {
      const connection = await this.deps.ensureConnected(cwd)
      this.deps.assertCurrentConnection(connection)
      const currentPublishedSession = this.deps.registry.lookup(request.sessionId)?.attachment
        ?.session
      const crossedGeneration = identity.renew(
        currentPublishedSession === publishedSession && currentPublishedSession
          ? request.sessionId
          : undefined
      )
      const reconnectReplacedPublishedSession =
        publishedSession !== undefined && currentPublishedSession === undefined && crossedGeneration
      if (currentPublishedSession !== publishedSession && !reconnectReplacedPublishedSession) {
        throw new Error('ACP session startup was superseded.')
      }

      this.deps.permission.cancelForSession(request.sessionId)
      this.deps.clearUserChoiceProvenanceForSession(request.sessionId)
      this.deps.elicitation.cancelForSession(request.sessionId)
      this.deps.appContinuations.delete(request.sessionId)
      this.deps.permission.clearLivePermissionProfile(request.sessionId)
      const attachment = this.deps.registry.lookup(request.sessionId)?.attachment
      if (attachment) {
        attachment.session.dispose()
        this.deps.registry.detach(attachment, 'provider')
      }
      this.deps.promptContent.resetSession(request.sessionId)
      this.deps.contextUsage.deleteSession(request.sessionId)
      this.deps.registry.lookup(request.sessionId)?.aggregate.clearAppliedModel()
      this.deps.interactions.supersedeCurrent(request.sessionId)

      // Await inside the reservation scope: adoption extends the same identity to the new provider id.
      return await this.deps.adopter.adopt(request.sessionId, {
        connection,
        cwd,
        projectId,
        identity,
        permissionProfile: request.permissionProfile,
        specialistId: request.specialistId,
        memoryEnabled: request.memoryEnabled
      })
    } catch (error) {
      if (previousMemoryEnabled !== undefined) {
        this.deps.registry
          .lookup(request.sessionId)
          ?.aggregate.setMemoryEnabled(previousMemoryEnabled)
      }
      throw error
    } finally {
      identity.release()
    }
  }

  async switchSpecialist(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<{ contextReset: boolean }> {
    if (this.deps.interactions.current(sessionId)) {
      throw new Error('Cannot switch specialist while the Agent is running.')
    }

    const { aggregate } = this.deps.registry.ensureAffinity(sessionId)
    // Projection is intentionally eager and is not rolled back if identity resolution or reset fails.
    aggregate.setSpecialistId(specialistId)

    if (specialistId !== undefined && this.deps.resolveSpecialistIdentity) {
      const identity = await this.deps.resolveSpecialistIdentity(
        specialistId,
        this.deps.currentFrameworkId()
      )
      aggregate.setSpecialistPrefix(identity?.prefix || undefined)
    } else {
      aggregate.setSpecialistPrefix(undefined)
    }

    this.deps.registerSessionSpecialist?.(sessionId, specialistId)

    const requiresContextReset =
      this.deps.currentFrameworkId() === 'claude-code' &&
      this.deps.registry.lookup(sessionId)?.attachment !== undefined
    if (requiresContextReset) {
      const snapshot = aggregate.snapshot()
      await this.reset({
        sessionId,
        cwd: snapshot.cwd,
        projectId: snapshot.projectId,
        ...(snapshot.permissionProfile?.selectedProfile
          ? { permissionProfile: snapshot.permissionProfile.selectedProfile }
          : {}),
        memoryEnabled: snapshot.memoryEnabled
      } as AcpResumeSessionRequest)
    }

    return { contextReset: requiresContextReset }
  }
}

export type { AcpSessionReplacementWorkflowDependencies }
