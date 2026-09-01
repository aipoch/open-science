import * as acp from '@agentclientprotocol/sdk'
import type { ActiveSession, ClientConnection, SessionConfigOption } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'

import type {
  AcpCreateSessionResponse,
  AcpResumeSessionRequest,
  AcpRuntimeEventInput
} from '../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  normalizePermissionProfile
} from '../../shared/permission-profiles'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import type { AcpProviderSessionAdopter } from './provider-session-adopter'
import {
  type AcpSessionCapabilityOwner,
  type SessionCapabilityPolicy,
  type SessionCapabilityProvision
} from './session-capability-owner'
import type { AcpSessionConfigurator } from './session-configurator'
import {
  AcpSessionPresentationPolicy,
  type AcpSessionSetupPresentation
} from './session-presentation-policy'
import type {
  AcpPrimarySessionIdentityReservation,
  AcpPrimarySessionIdentityReservationResult,
  AcpSessionAttachment,
  AcpSessionRegistry
} from './session-registry'
import { AcpSessionResumePolicy } from './session-resume-policy'

const log = createLogger('acp')

type SessionAttachmentResponse = {
  sessionId: string
  modes?: ActiveSession['modes'] | null
  configOptions?: unknown
  _meta?: unknown
}

type ClientContextSessionAttacher = {
  attachSession: (response: SessionAttachmentResponse) => ActiveSession
}

type ResumeEvent = AcpRuntimeEventInput

type AcpProviderSessionResumerDependencies = Readonly<{
  defaultCwd: string
  defaultProjectId: string
  currentCwd: () => string | undefined
  currentConnection: () => ClientConnection | undefined
  ensureConnected: (cwd: string) => Promise<ClientConnection>
  assertCurrentConnection: (connection: ClientConnection) => void
  disconnectTimedOutConnection: () => Promise<void>
  resumeCapabilityAdvertised: () => boolean
  currentBackend: () => AcpBackendGenerationView
  registry: AcpSessionRegistry
  reserveIdentity: (sessionId: string) => AcpPrimarySessionIdentityReservationResult
  capabilities: Pick<AcpSessionCapabilityOwner, 'provision'>
  capabilityPolicy: SessionCapabilityPolicy
  configurator: Pick<AcpSessionConfigurator, 'configure' | 'configurePermissionProfile'>
  adopter: Pick<AcpProviderSessionAdopter, 'adopt'>
  clearLivePermissionProfile: (sessionId: string) => void
  resolveSpecialistIdentity?: (
    specialistId: string,
    frameworkId: string
  ) => Promise<{ append: string; prefix: string } | undefined>
  resolveSpecialistSkills?: (specialistId: string) => Promise<EffectiveSpecialistSkills>
  // The ACP projectId carries the Project id (see workspace-conversation-controller). Returns
  // undefined when the project has no Agent Context or the lookup fails; failures never block
  // session resume.
  resolveProjectAgentContext?: (projectId: string) => Promise<string | undefined>
  updateCwd: (cwd: string) => void
  pushEvent: (event: ResumeEvent) => void
  emitState: () => void
  resumeTimeoutMs: number
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  diagnosticContext: () => Readonly<Record<string, unknown>>
}>

export class AcpProviderSessionResumer {
  private readonly policy = new AcpSessionResumePolicy()
  private readonly presentation = new AcpSessionPresentationPolicy()
  private readonly progressObservers = new Map<string, Set<() => void>>()

  constructor(private readonly deps: AcpProviderSessionResumerDependencies) {}

  observeProgress(providerSessionId: string): void {
    const observers = this.progressObservers.get(providerSessionId)
    if (!observers) return
    for (const observer of observers) observer()
  }

  async resume(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    const attached = this.deps.registry.lookup(request.sessionId)?.attachment
    if (attached) return this.resumeAttached(request, attached)

    return this.resumeDetached(request, false)
  }

  async reconfigure(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    const entry = this.deps.registry.lookup(request.sessionId)
    const attachment = entry?.attachment
    const snapshot = entry?.aggregate.snapshot()
    const providerSessionId = attachment?.providerSessionId ?? request.providerSessionId
    if (!attachment) {
      return this.resumeDetached(
        { ...request, ...(providerSessionId ? { providerSessionId } : {}) },
        true
      )
    }
    this.deps.registry.detach(attachment, 'provider')
    try {
      const result = await this.resumeDetached(
        { ...request, providerSessionId: attachment.providerSessionId },
        true
      )
      attachment.session.dispose()
      return result
    } catch (error) {
      if (
        snapshot?.cwd &&
        snapshot.projectId &&
        snapshot.frameworkId &&
        snapshot.permissionProfile
      ) {
        const restored = this.deps.registry.reserve({
          sessionIds: [request.sessionId, attachment.providerSessionId],
          blockStartup: false
        })
        if (!restored.collision) {
          try {
            this.deps.registry.publish(restored.reservation, request.sessionId, {
              session: attachment.session,
              cwd: snapshot.cwd,
              projectId: snapshot.projectId,
              frameworkId: snapshot.frameworkId,
              ...(snapshot.backendId ? { backendId: snapshot.backendId } : {}),
              permissionProfile: {
                ...snapshot.permissionProfile,
                availableModeIds: [...snapshot.permissionProfile.availableModeIds]
              },
              ...(snapshot.appliedModel ? { appliedModel: snapshot.appliedModel } : {}),
              ...(snapshot.configOptions
                ? {
                    configOptions: structuredClone(snapshot.configOptions) as SessionConfigOption[]
                  }
                : {})
            })
          } finally {
            restored.reservation.release()
          }
        }
      }
      throw error
    }
  }

  private async resumeDetached(
    request: AcpResumeSessionRequest,
    compatibleOnly: boolean
  ): Promise<AcpCreateSessionResponse> {
    const cwd = resolve(request.cwd || this.deps.currentCwd() || this.deps.defaultCwd)
    const projectId = request.projectId?.trim() || this.deps.defaultProjectId
    const reserved = this.deps.reserveIdentity(request.sessionId)
    if (reserved.collision) throw reserved.collision
    const identity = reserved.reservation

    try {
      const connection = await this.withTimeout(() => this.deps.ensureConnected(cwd))
      this.deps.assertCurrentConnection(connection)
      identity.renew()
      return await this.withTimeout(
        (cancellationSignal) =>
          this.resumeConnected(
            request,
            connection,
            cwd,
            projectId,
            identity,
            compatibleOnly,
            cancellationSignal
          ),
        this.progressSessionIds(request)
      )
    } finally {
      identity.release()
    }
  }

  private async resumeAttached(
    request: AcpResumeSessionRequest,
    attachment: AcpSessionAttachment
  ): Promise<AcpCreateSessionResponse> {
    if (request.specialistBindingPending === true) {
      throw new Error(
        'A pending Specialist binding cannot be reconciled through an already attached provider session.'
      )
    }
    const entry = this.deps.registry.lookup(request.sessionId)
    if (!entry) throw new Error(`ACP session is not registered: ${request.sessionId}`)
    const connection = this.deps.currentConnection()
    if (!connection) throw new Error('ACP connection is not available.')

    const cwd = resolve(request.cwd || this.deps.currentCwd() || this.deps.defaultCwd)
    const projectId = request.projectId?.trim() || this.deps.defaultProjectId
    const backend = this.deps.currentBackend()
    if (request.specialistId) entry.aggregate.setSpecialistId(request.specialistId)
    const permissionProfile = await this.deps.configurator.configurePermissionProfile({
      backend,
      connection,
      session: attachment.session,
      permissionProfile: normalizePermissionProfile(
        request.permissionProfile ??
          entry.aggregate.snapshot().permissionProfile?.selectedProfile ??
          DEFAULT_PERMISSION_PROFILE
      )
    })
    const current = this.deps.registry.lookup(request.sessionId)
    if (
      current?.attachment?.generation !== attachment.generation ||
      current.attachment.session !== attachment.session
    ) {
      throw new Error('ACP session startup was superseded.')
    }
    this.deps.assertCurrentConnection(connection)
    current.aggregate.setPermissionProfile(structuredClone(permissionProfile))
    this.deps.clearLivePermissionProfile(request.sessionId)
    this.deps.registry.select(request.sessionId)
    this.deps.updateCwd(cwd)
    current.aggregate.updateLocation(cwd, projectId)
    this.deps.emitState()

    const responseBackend = this.deps.currentBackend()
    return {
      sessionId: request.sessionId,
      providerSessionId: attachment.providerSessionId,
      ...(responseBackend.providerContinuityToken
        ? { providerContinuityToken: responseBackend.providerContinuityToken }
        : {}),
      cwd,
      frameworkId: responseBackend.framework.id,
      ...(responseBackend.backendId ? { backendId: responseBackend.backendId } : {})
    }
  }

  private async withTimeout<Result>(
    operation: (cancellationSignal: AbortSignal) => Promise<Result>,
    progressSessionIds: readonly string[] = []
  ): Promise<Result> {
    const cancellation = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let settled = false
    let rejectTimeout!: (error: Error) => void
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject
    })
    const renewTimeout = (): void => {
      if (settled || timedOut) return
      if (timer !== undefined) this.deps.clearTimer(timer)
      timer = this.deps.setTimer(() => {
        timedOut = true
        const error = new Error('ACP session resume timed out.')
        cancellation.abort(error)
        rejectTimeout(error)
      }, this.deps.resumeTimeoutMs)
    }
    const unsubscribe = this.subscribeToProgress(progressSessionIds, renewTimeout)
    renewTimeout()

    try {
      return await Promise.race([operation(cancellation.signal), timeout])
    } catch (error) {
      if (timedOut) await this.deps.disconnectTimedOutConnection()
      throw error
    } finally {
      settled = true
      unsubscribe()
      if (timer !== undefined) this.deps.clearTimer(timer)
    }
  }

  private progressSessionIds(request: AcpResumeSessionRequest): string[] {
    const registeredProviderSessionId = this.deps.registry
      .lookup(request.sessionId)
      ?.aggregate.snapshot().providerSessionId
    return [request.sessionId, request.providerSessionId, registeredProviderSessionId].filter(
      (sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0
    )
  }

  private subscribeToProgress(sessionIds: readonly string[], observer: () => void): () => void {
    const subscribedIds = [...new Set(sessionIds)]
    for (const sessionId of subscribedIds) {
      const observers = this.progressObservers.get(sessionId) ?? new Set<() => void>()
      observers.add(observer)
      this.progressObservers.set(sessionId, observers)
    }
    return () => {
      for (const sessionId of subscribedIds) {
        const observers = this.progressObservers.get(sessionId)
        if (!observers) continue
        observers.delete(observer)
        if (observers.size === 0) this.progressObservers.delete(sessionId)
      }
    }
  }

  private async resumeConnected(
    request: AcpResumeSessionRequest,
    connection: ClientConnection,
    cwd: string,
    projectId: string,
    identity: AcpPrimarySessionIdentityReservation,
    compatibleOnly: boolean,
    cancellationSignal: AbortSignal
  ): Promise<AcpCreateSessionResponse> {
    const affinity = this.deps.registry.lookup(request.sessionId)?.aggregate.snapshot()
    const persistedProviderSessionId = affinity?.providerSessionId ?? request.providerSessionId
    const backend = this.deps.currentBackend()
    if (request.specialistBindingPending === true) {
      if (compatibleOnly) {
        throw new Error('ACP capability reconfiguration requires a compatible provider resume.')
      }
      log.info('adopting fresh provider context for pending Specialist binding', {
        sessionId: request.sessionId,
        ...this.deps.diagnosticContext()
      })
      return this.adopt(request, connection, cwd, projectId, identity)
    }
    if (compatibleOnly && persistedProviderSessionId) {
      return this.resumeCompatible(
        request,
        connection,
        cwd,
        projectId,
        identity,
        persistedProviderSessionId,
        true,
        true,
        cancellationSignal
      )
    }
    const decision = this.policy.decide({
      appSessionId: request.sessionId,
      providerSessionId: persistedProviderSessionId ?? request.sessionId,
      previousFrameworkId: affinity?.frameworkId ?? request.previousFrameworkId,
      currentFrameworkId: backend.framework.id,
      previousBackendId: affinity?.backendId ?? request.previousBackendId,
      currentBackendId: backend.backendId,
      currentModelRoute: backend.modelRoute,
      previousProviderContinuityToken: request.providerContinuityToken,
      currentProviderContinuityToken: backend.providerContinuityToken,
      resumeCapabilityAdvertised: this.deps.resumeCapabilityAdvertised()
    })

    if (decision.action === 'adopt') {
      if (compatibleOnly) {
        throw new Error(
          `ACP capability reconfiguration cannot replace provider context (${decision.reason}).`
        )
      }
      log.info('skipping incompatible provider resume; adopting a fresh session', {
        sessionId: request.sessionId,
        reason: decision.reason,
        ...this.deps.diagnosticContext()
      })
      return this.adopt(request, connection, cwd, projectId, identity)
    }
    return this.resumeCompatible(
      request,
      connection,
      cwd,
      projectId,
      identity,
      decision.providerSessionId,
      persistedProviderSessionId !== undefined,
      compatibleOnly,
      cancellationSignal
    )
  }

  private async resumeCompatible(
    request: AcpResumeSessionRequest,
    connection: ClientConnection,
    cwd: string,
    projectId: string,
    identity: AcpPrimarySessionIdentityReservation,
    providerSessionId: string,
    providerSessionIdPersisted: boolean,
    compatibleOnly: boolean,
    cancellationSignal: AbortSignal
  ): Promise<AcpCreateSessionResponse> {
    let capability: SessionCapabilityProvision | undefined
    let provisionalSession: ActiveSession | undefined
    try {
      let backend = this.deps.currentBackend()
      capability = await this.deps.capabilities.provision({
        stableAppSessionId: request.sessionId,
        framework: backend.framework,
        nativeMcpEnabled: backend.adapter.nativeMcpEnabled,
        bridgeMcpAliasesEnabled: backend.adapter.bridgeMcpAliasesEnabled,
        policy: this.deps.capabilityPolicy,
        sessionCwd: cwd,
        projectId,
        memoryEnabled: request.memoryEnabled
      })
      const capabilityDescriptor = capability.descriptor
      const existingAggregate = this.deps.registry.lookup(request.sessionId)?.aggregate
      let specialistBindingRevision = existingAggregate?.specialistBindingRevision() ?? 0
      let specialistId = request.specialistId ?? existingAggregate?.snapshot().specialistId
      const projectContextAppend = await this.resolveProjectAgentContext(projectId)
      const resolveSpecialistProjection = async (
        currentSpecialistId: string | undefined,
        currentBackend: AcpBackendGenerationView
      ): Promise<{
        identity: { append: string; prefix: string } | undefined
        setup: AcpSessionSetupPresentation
      }> => {
        const [identity, skills] = await Promise.all([
          this.resolveSpecialistIdentity(currentSpecialistId, currentBackend),
          this.resolveSpecialistSkills(currentSpecialistId)
        ])
        return {
          identity,
          setup: this.presentation.buildSessionSetup({
            framework: currentBackend.framework,
            tooling: {
              artifacts: capabilityDescriptor.capabilities.includes('artifacts'),
              notebook: capabilityDescriptor.capabilities.includes('notebook'),
              skillImport: capabilityDescriptor.capabilities.includes('skill-import')
            },
            role: capabilityDescriptor.role,
            backendSystemPromptAppends: currentBackend.prompt.systemPromptAppends,
            extraSystemPromptAppends: [projectContextAppend, identity?.append].filter(
              (append): append is string => Boolean(append)
            ),
            persistentSystemPrompt: currentBackend.prompt.persistentSystemPrompt,
            sessionOptions: currentBackend.session.options,
            specialistSkills: skills
          })
        }
      }
      let specialistProjection = await resolveSpecialistProjection(specialistId, backend)
      const sessionCapabilities = capability.includeFrameworkMcpServers(
        specialistProjection.setup.mcpServers ?? []
      )

      let resumeResponse: unknown
      try {
        resumeResponse = await connection.agent.request(
          acp.methods.agent.session.resume,
          {
            sessionId: providerSessionId,
            cwd,
            mcpServers: sessionCapabilities.mcpServers,
            ...specialistProjection.setup.metaArg
          },
          { cancellationSignal }
        )
      } catch (error) {
        const failure = this.policy.classifyFailure(error, {
          currentFrameworkId: backend.framework.id,
          currentModelRoute: backend.modelRoute,
          providerSessionIdPersisted
        })
        if (failure.disposition !== 'adoptable' || compatibleOnly) throw error
        try {
          identity.assertCurrent()
        } catch (supersededError) {
          capability.release({ ownsStableIdentity: false })
          capability = undefined
          throw supersededError
        }
        capability.release({ ownsStableIdentity: true })
        capability = undefined
        log.info('resumed session adopted after unrecoverable resume error', {
          sessionId: request.sessionId,
          ...errorLogFields(error)
        })
        return await this.adopt(request, connection, cwd, projectId, identity)
      }

      provisionalSession = (
        connection.agent as unknown as ClientContextSessionAttacher
      ).attachSession({ sessionId: providerSessionId, ...(resumeResponse as object) })
      const resumedProviderSessionId = provisionalSession.sessionId
      const extended = this.deps.registry.reserve({
        reservation: identity,
        sessionIds: [provisionalSession.sessionId]
      })
      if (extended.collision) {
        this.disposeProvisional(provisionalSession, 'primary collision session disposal failed')
        provisionalSession = undefined
        throw extended.collision
      }

      const permission = normalizePermissionProfile(request.permissionProfile)
      let configuration = await this.deps.configurator.configure({
        backend,
        connection,
        session: provisionalSession,
        permissionProfile: permission
      })
      for (;;) {
        const currentBackend = this.deps.currentBackend()
        if (currentBackend !== backend) {
          backend = currentBackend
          configuration = await this.deps.configurator.configure({
            backend,
            connection,
            session: provisionalSession,
            permissionProfile: permission
          })
          specialistProjection = await resolveSpecialistProjection(specialistId, backend)
          continue
        }
        identity.assertCurrent()
        const currentSpecialistBindingRevision =
          this.deps.registry.lookup(request.sessionId)?.aggregate.specialistBindingRevision() ?? 0
        if (currentSpecialistBindingRevision !== specialistBindingRevision) {
          // These frameworks carry Specialist identity and scope in turn prefixes, so an in-flight
          // switch can be reconciled locally without disposing, resuming again, or replaying the
          // persisted provider Session. Session-metadata backends still require replacement.
          if (backend.framework.id === 'claude-code') {
            throw new Error('ACP session startup was superseded.')
          }
          const currentAggregate = this.deps.registry.lookup(request.sessionId)?.aggregate
          specialistBindingRevision = currentAggregate?.specialistBindingRevision() ?? 0
          specialistId = currentAggregate?.snapshot().specialistId
          specialistProjection = await resolveSpecialistProjection(specialistId, backend)
          continue
        }
        const { aggregate } = this.deps.registry.publish(identity, request.sessionId, {
          session: provisionalSession,
          cwd,
          projectId,
          frameworkId: backend.framework.id,
          backendId: backend.backendId,
          permissionProfile: structuredClone(configuration.permissionProfile),
          memoryEnabled: request.memoryEnabled !== false,
          appliedModel: configuration.appliedModel,
          configOptions: structuredClone(configuration.configOptions)
        })
        aggregate.setSessionSetupPromptPrefix(specialistProjection.setup.promptPrefix)
        aggregate.setSpecialistPrefix(specialistProjection.identity?.prefix || undefined)
        aggregate.setSpecialistId(specialistId)
        capability.commit(request.sessionId)
        capability = undefined
        provisionalSession = undefined
        identity.release()
        this.publish(request.sessionId, cwd)
        return {
          sessionId: request.sessionId,
          providerSessionId: resumedProviderSessionId,
          ...(backend.providerContinuityToken
            ? { providerContinuityToken: backend.providerContinuityToken }
            : {}),
          cwd,
          frameworkId: backend.framework.id,
          ...(backend.backendId ? { backendId: backend.backendId } : {})
        }
      }
    } catch (caught) {
      let startupError = caught
      let ownsStableIdentity = true
      try {
        identity.assertCurrent()
      } catch (supersededError) {
        startupError = supersededError
        ownsStableIdentity = false
      }
      capability?.release({ ownsStableIdentity })
      this.disposeProvisional(provisionalSession, 'resumed startup session disposal failed')
      throw startupError
    }
  }

  private adopt(
    request: AcpResumeSessionRequest,
    connection: ClientConnection,
    cwd: string,
    projectId: string,
    identity: AcpPrimarySessionIdentityReservation
  ): Promise<AcpCreateSessionResponse> {
    return this.deps.adopter.adopt(request.sessionId, {
      connection,
      cwd,
      projectId,
      identity,
      permissionProfile: request.permissionProfile,
      specialistId: request.specialistId,
      specialistBindingPending: request.specialistBindingPending,
      memoryEnabled: request.memoryEnabled
    })
  }

  private async resolveProjectAgentContext(projectId: string): Promise<string | undefined> {
    if (!this.deps.resolveProjectAgentContext) return undefined
    const context = await this.deps.resolveProjectAgentContext(projectId)
    return this.presentation.projectAgentContext(context)
  }

  private async resolveSpecialistSkills(
    specialistId: string | undefined
  ): Promise<EffectiveSpecialistSkills | undefined> {
    if (!specialistId || !this.deps.resolveSpecialistSkills) return undefined
    try {
      return await this.deps.resolveSpecialistSkills(specialistId)
    } catch {
      return { kind: 'unavailable', reason: 'The bound specialist is unavailable.' }
    }
  }

  private async resolveSpecialistIdentity(
    specialistId: string | undefined,
    backend: AcpBackendGenerationView
  ): Promise<{ append: string; prefix: string } | undefined> {
    if (!specialistId) return undefined
    if (!this.deps.resolveSpecialistIdentity) {
      throw new Error('The bound specialist is unavailable.')
    }
    try {
      const identity = await this.deps.resolveSpecialistIdentity(specialistId, backend.framework.id)
      if (!identity) throw new Error('The bound specialist is unavailable.')
      return identity
    } catch {
      throw new Error('The bound specialist is unavailable.')
    }
  }

  private publish(sessionId: string, cwd: string): void {
    this.deps.updateCwd(cwd)
    try {
      this.deps.pushEvent({
        kind: 'system',
        level: 'info',
        sessionId,
        title: 'Session resumed',
        text: cwd
      })
    } catch (error) {
      this.safeLogError('session resumed event callback failed', error, sessionId)
    }
    try {
      this.deps.emitState()
    } catch (error) {
      this.safeLogError('session resumed state callback failed', error, sessionId)
    }
  }

  private disposeProvisional(session: ActiveSession | undefined, message: string): void {
    if (!session) return
    try {
      session.dispose()
    } catch (error) {
      this.safeLogError(message, error, session.sessionId, false)
    }
  }

  private safeLogError(
    message: string,
    error: unknown,
    sessionId: string,
    includeContext = true
  ): void {
    try {
      log.error(message, {
        ...diagnosticErrorFields(error),
        ...(includeContext ? this.deps.diagnosticContext() : {}),
        sessionId
      })
    } catch {
      // Diagnostics must never replace provider, cleanup, or observer outcomes.
    }
  }
}
