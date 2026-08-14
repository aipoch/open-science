import * as acp from '@agentclientprotocol/sdk'
import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'

import type {
  AcpCreateSessionResponse,
  AcpResumeSessionRequest,
  AcpRuntimeEvent
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
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
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

type ResumeEvent = Omit<AcpRuntimeEvent, 'id' | 'timestamp'>

type AcpProviderSessionResumerDependencies = Readonly<{
  defaultCwd: string
  defaultProjectName: string
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
  resolveSpecialistSkills?: (specialistId: string) => Promise<EffectiveSpecialistSkills>
  // The ACP projectName carries the Project id (see workspace-conversation-controller). Returns
  // undefined when the project has no Agent Context or the lookup fails; failures never block
  // session resume.
  resolveProjectAgentContext?: (projectName: string) => Promise<string | undefined>
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

  constructor(private readonly deps: AcpProviderSessionResumerDependencies) {}

  async resume(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    const attached = this.deps.registry.lookup(request.sessionId)?.attachment
    if (attached) return this.resumeAttached(request, attached)

    const cwd = resolve(request.cwd || this.deps.currentCwd() || this.deps.defaultCwd)
    const projectName = request.projectName?.trim() || this.deps.defaultProjectName
    const reserved = this.deps.reserveIdentity(request.sessionId)
    if (reserved.collision) throw reserved.collision
    const identity = reserved.reservation

    try {
      return await this.withTimeout(() => this.resumeReserved(request, cwd, projectName, identity))
    } finally {
      identity.release()
    }
  }

  private async resumeAttached(
    request: AcpResumeSessionRequest,
    attachment: AcpSessionAttachment
  ): Promise<AcpCreateSessionResponse> {
    const entry = this.deps.registry.lookup(request.sessionId)
    if (!entry) throw new Error(`ACP session is not registered: ${request.sessionId}`)
    const connection = this.deps.currentConnection()
    if (!connection) throw new Error('ACP connection is not available.')

    const cwd = resolve(request.cwd || this.deps.currentCwd() || this.deps.defaultCwd)
    const projectName = request.projectName?.trim() || this.deps.defaultProjectName
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
    current.aggregate.updateLocation(cwd, projectName)
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

  private async withTimeout(
    operation: () => Promise<AcpCreateSessionResponse>
  ): Promise<AcpCreateSessionResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.deps.setTimer(() => {
        timedOut = true
        reject(new Error('ACP session resume timed out.'))
      }, this.deps.resumeTimeoutMs)
    })

    try {
      return await Promise.race([operation(), timeout])
    } catch (error) {
      if (timedOut) await this.deps.disconnectTimedOutConnection()
      throw error
    } finally {
      if (timer !== undefined) this.deps.clearTimer(timer)
    }
  }

  private async resumeReserved(
    request: AcpResumeSessionRequest,
    cwd: string,
    projectName: string,
    identity: AcpPrimarySessionIdentityReservation
  ): Promise<AcpCreateSessionResponse> {
    const connection = await this.deps.ensureConnected(cwd)
    this.deps.assertCurrentConnection(connection)
    identity.renew()

    const affinity = this.deps.registry.lookup(request.sessionId)?.aggregate.snapshot()
    const persistedProviderSessionId = affinity?.providerSessionId ?? request.providerSessionId
    const backend = this.deps.currentBackend()
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
      log.info('skipping incompatible provider resume; adopting a fresh session', {
        sessionId: request.sessionId,
        reason: decision.reason,
        ...this.deps.diagnosticContext()
      })
      return this.adopt(request, connection, cwd, projectName, identity)
    }
    return this.resumeCompatible(
      request,
      connection,
      cwd,
      projectName,
      identity,
      decision.providerSessionId,
      persistedProviderSessionId !== undefined
    )
  }

  private async resumeCompatible(
    request: AcpResumeSessionRequest,
    connection: ClientConnection,
    cwd: string,
    projectName: string,
    identity: AcpPrimarySessionIdentityReservation,
    providerSessionId: string,
    providerSessionIdPersisted: boolean
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
        projectName
      })
      const specialistId =
        request.specialistId ??
        this.deps.registry.lookup(request.sessionId)?.aggregate.snapshot().specialistId
      const projectContextAppend = await this.resolveProjectAgentContext(projectName)
      const setup = this.presentation.buildSessionSetup({
        framework: backend.framework,
        tooling: {
          artifacts: capability.descriptor.capabilities.includes('artifacts'),
          notebook: capability.descriptor.capabilities.includes('notebook'),
          skillImport: capability.descriptor.capabilities.includes('skill-import')
        },
        backendSystemPromptAppends: backend.prompt.systemPromptAppends,
        extraSystemPromptAppends: projectContextAppend ? [projectContextAppend] : [],
        sessionOptions: backend.session.options,
        skillRuntime: backend.skillRuntime,
        specialistSkills: await this.resolveSpecialistSkills(specialistId)
      })

      let resumeResponse: unknown
      try {
        resumeResponse = await connection.agent.request(acp.methods.agent.session.resume, {
          sessionId: providerSessionId,
          cwd,
          mcpServers: capability.mcpServers,
          ...(backend.adapter.additionalDirectories?.length
            ? { additionalDirectories: [...backend.adapter.additionalDirectories] }
            : {}),
          ...setup.metaArg
        })
      } catch (error) {
        const failure = this.policy.classifyFailure(error, {
          currentFrameworkId: backend.framework.id,
          currentModelRoute: backend.modelRoute,
          providerSessionIdPersisted
        })
        if (failure.disposition !== 'adoptable') throw error
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
        return await this.adopt(request, connection, cwd, projectName, identity)
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
          continue
        }
        identity.assertCurrent()
        const { aggregate } = this.deps.registry.publish(identity, request.sessionId, {
          session: provisionalSession,
          cwd,
          projectName,
          frameworkId: backend.framework.id,
          backendId: backend.backendId,
          permissionProfile: structuredClone(configuration.permissionProfile),
          appliedModel: configuration.appliedModel,
          configOptions: structuredClone(configuration.configOptions)
        })
        aggregate.setSessionSetupPromptPrefix(setup.promptPrefix)
        if (request.specialistId) aggregate.setSpecialistId(request.specialistId)
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
    projectName: string,
    identity: AcpPrimarySessionIdentityReservation
  ): Promise<AcpCreateSessionResponse> {
    return this.deps.adopter.adopt(request.sessionId, {
      connection,
      cwd,
      projectName,
      identity,
      permissionProfile: request.permissionProfile,
      specialistId: request.specialistId
    })
  }

  private async resolveProjectAgentContext(projectName: string): Promise<string | undefined> {
    if (!this.deps.resolveProjectAgentContext) return undefined
    try {
      const context = await this.deps.resolveProjectAgentContext(projectName)
      const trimmed = context?.trim()
      return trimmed ? trimmed : undefined
    } catch (error) {
      log.warn('project Agent Context resolution failed', errorLogFields(error))
      return undefined
    }
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
