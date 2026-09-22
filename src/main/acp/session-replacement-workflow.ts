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
  reconfigureSession: (request: AcpResumeSessionRequest) => Promise<AcpCreateSessionResponse>
  assertSkillScopeRefreshSupported: () => void
  permission: Pick<AcpPermissionContext, 'cancelForSession' | 'clearLivePermissionProfile'>
  elicitation: Pick<AcpElicitationOwner, 'cancelForSession'>
  clearUserChoiceProvenanceForSession: (sessionId: string) => void
  appContinuations: Pick<AcpAppContinuationOwner, 'delete'>
  promptContent: Pick<AcpPromptContentOwner, 'resetSession'>
  releasePromptResourcesForSession: (sessionId: string) => void
  contextUsage: Pick<ContextUsageTracker, 'deleteSession'>
  interactions: Pick<AcpSessionInteractionOwner, 'current' | 'supersedeCurrent'>
  resolveSpecialistIdentity?: (
    specialistId: string,
    frameworkId: AgentFrameworkId
  ) => Promise<{ append: string; prefix: string } | undefined>
  registerSessionSpecialist?: (sessionId: string, specialistId: string | undefined) => void
}>

// Hooks run while the old attachment remains authoritative. onBeforeCommit may persist a
// candidate binding; onCommitFailed must undo that write if the synchronous publication loses
// ownership. assertCurrent is checked after preparation awaits and immediately before publish.
export type AcpSessionReplacementOptions = Readonly<{
  assertCurrent?: () => void
  onCandidateCreated?: (providerSessionId: string) => Promise<void>
  onBeforeCommit?: (providerSessionId: string) => Promise<void>
  onCommitFailed?: (providerSessionId: string, error: unknown) => Promise<void>
}>

export class AcpSessionReplacementWorkflow {
  constructor(private readonly deps: AcpSessionReplacementWorkflowDependencies) {}

  // Coordinates owner cleanup without retaining Session facts; the Registry and each state owner
  // remain authoritative while the Adopter publishes the replacement provider Session.
  async reset(
    request: AcpResumeSessionRequest,
    options: AcpSessionReplacementOptions = {}
  ): Promise<AcpCreateSessionResponse> {
    const cwd = resolve(request.cwd || this.deps.currentCwd() || this.deps.defaultCwd)
    const projectId = request.projectId?.trim() || this.deps.defaultProjectId
    const publishedSession = this.deps.registry.lookup(request.sessionId)?.attachment?.session
    const reserved = this.deps.reserveIdentity(
      request.sessionId,
      publishedSession ? request.sessionId : undefined
    )
    if (reserved.collision) throw reserved.collision
    const identity = reserved.reservation

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

      const preparedAttachment = this.deps.registry.lookup(request.sessionId)?.attachment
      const assertCurrent = (): void => {
        identity.assertCurrent()
        this.deps.assertCurrentConnection(connection)
        options.assertCurrent?.()
        if (this.deps.registry.lookup(request.sessionId)?.attachment !== preparedAttachment) {
          throw new Error('ACP session startup was superseded.')
        }
      }
      assertCurrent()

      // Await inside the reservation scope: adoption extends the same identity to the new provider id.
      return await this.deps.adopter.adopt(request.sessionId, {
        connection,
        cwd,
        projectId,
        identity,
        permissionProfile: request.permissionProfile,
        specialistId: request.specialistId,
        memoryEnabled: request.memoryEnabled,
        replacement: {
          assertCurrent,
          onCandidateCreated: options.onCandidateCreated,
          onBeforeCommit: options.onBeforeCommit,
          onCommitFailed: options.onCommitFailed,
          afterPublish: () => {
            try {
              this.deps.permission.cancelForSession(request.sessionId)
              this.deps.clearUserChoiceProvenanceForSession(request.sessionId)
              this.deps.elicitation.cancelForSession(request.sessionId)
              this.deps.appContinuations.delete(request.sessionId)
              this.deps.permission.clearLivePermissionProfile(request.sessionId)
              this.deps.promptContent.resetSession(request.sessionId)
              this.deps.releasePromptResourcesForSession(request.sessionId)
              this.deps.contextUsage.deleteSession(request.sessionId)
              this.deps.interactions.supersedeCurrent(request.sessionId)
            } finally {
              publishedSession?.dispose()
            }
          }
        }
      })
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
    const previousAttachment = this.deps.registry.lookup(sessionId)?.attachment
    const isCodex = this.deps.currentFrameworkId() === 'codex'
    const refreshCodex = isCodex && previousAttachment !== undefined
    let codexIdentity: { append: string; prefix: string } | undefined
    if (isCodex) {
      const revision = aggregate.specialistBindingRevision()
      if (specialistId !== undefined && this.deps.resolveSpecialistIdentity) {
        codexIdentity = await this.deps.resolveSpecialistIdentity(specialistId, 'codex')
      }
      // Resolve before mutating the binding. A prompt or a newer switch may win while awaiting
      // identity; neither may be interrupted or overwritten by this scope refresh.
      if (this.deps.interactions.current(sessionId)) {
        throw new Error('Cannot switch specialist while the Agent is running.')
      }
      if (
        aggregate.specialistBindingRevision() !== revision ||
        this.deps.registry.lookup(sessionId)?.attachment !== previousAttachment ||
        this.deps.currentFrameworkId() !== 'codex'
      ) {
        throw new Error('ACP session startup was superseded.')
      }
    }
    // Unsupported runtimes must leave the old binding and attachment intact. After mutation,
    // failures deliberately detach a loader whose scope no longer matches the new binding.
    if (refreshCodex) this.deps.assertSkillScopeRefreshSupported()
    // Projection is intentionally eager and is not rolled back if identity resolution or reset fails.
    aggregate.setSpecialistId(specialistId)

    try {
      if (isCodex) {
        aggregate.setSpecialistPrefix(codexIdentity?.prefix || undefined)
      } else if (specialistId !== undefined && this.deps.resolveSpecialistIdentity) {
        const identity = await this.deps.resolveSpecialistIdentity(
          specialistId,
          this.deps.currentFrameworkId()
        )
        aggregate.setSpecialistPrefix(identity?.prefix || undefined)
      } else {
        aggregate.setSpecialistPrefix(undefined)
      }

      this.deps.registerSessionSpecialist?.(sessionId, specialistId)

      if (refreshCodex) {
        const snapshot = aggregate.snapshot()
        await this.deps.reconfigureSession({
          sessionId,
          providerSessionId: previousAttachment.providerSessionId,
          previousFrameworkId: 'codex',
          previousBackendId: snapshot.backendId,
          cwd: snapshot.cwd ?? this.deps.defaultCwd,
          projectId: snapshot.projectId,
          permissionProfile: snapshot.permissionProfile?.selectedProfile,
          specialistId,
          memoryEnabled: snapshot.memoryEnabled
        })
      }

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
    } catch (error) {
      // A failed Specialist switch has already changed its authoritative binding. Even though
      // reset preserves the old attachment, its baked-in identity no longer matches that binding.
      const currentAttachment = this.deps.registry.lookup(sessionId)?.attachment
      if (
        (refreshCodex || this.deps.currentFrameworkId() === 'claude-code') &&
        previousAttachment &&
        currentAttachment?.session === previousAttachment.session
      ) {
        currentAttachment.session.dispose()
        this.deps.registry.detach(currentAttachment, 'provider')
      }
      throw error
    }
  }
}

export type { AcpSessionReplacementWorkflowDependencies }
