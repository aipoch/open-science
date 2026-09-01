import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'

import type {
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpRuntimeEventInput
} from '../../shared/acp'
import { normalizePermissionProfile } from '../../shared/permission-profiles'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import {
  type AcpSessionCapabilityOwner,
  type SessionCapabilityPolicy,
  type SessionCapabilityProvision
} from './session-capability-owner'
import type { AcpSessionConfigurator } from './session-configurator'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
import type {
  AcpPrimarySessionIdentityReservationResult,
  AcpSessionRegistry
} from './session-registry'

const log = createLogger('acp')

type CreationEvent = AcpRuntimeEventInput

type AcpProviderSessionCreatorDependencies = Readonly<{
  defaultCwd: string
  defaultProjectId: string
  currentCwd: () => string | undefined
  ensureConnected: (cwd: string) => Promise<ClientConnection>
  assertCurrentConnection: (connection: ClientConnection) => void
  currentBackend: () => AcpBackendGenerationView
  registry: AcpSessionRegistry
  reserveIdentity: (
    sessionId: string,
    startupGeneration: number
  ) => AcpPrimarySessionIdentityReservationResult
  capabilities: Pick<AcpSessionCapabilityOwner, 'provision'>
  capabilityPolicy: SessionCapabilityPolicy
  configurator: Pick<AcpSessionConfigurator, 'configure'>
  resolveSpecialistIdentity?: (
    specialistId: string,
    frameworkId: string
  ) => Promise<{ append: string; prefix: string } | undefined>
  resolveSpecialistSkills?: (specialistId: string) => Promise<EffectiveSpecialistSkills>
  // The ACP projectId carries the Project id (see workspace-conversation-controller). Returns
  // undefined when the project has no Agent Context or the lookup fails; failures never block
  // session creation.
  resolveProjectAgentContext?: (projectId: string) => Promise<string | undefined>
  registerSessionSpecialist?: (sessionId: string, specialistId: string | undefined) => void
  updateCwd: (cwd: string) => void
  pushEvent: (event: CreationEvent) => void
  emitState: () => void
  diagnosticContext: () => Readonly<Record<string, unknown>>
}>

export class AcpProviderSessionCreator {
  private readonly presentation = new AcpSessionPresentationPolicy()

  constructor(private readonly deps: AcpProviderSessionCreatorDependencies) {}

  async create(request: AcpCreateSessionRequest = {}): Promise<AcpCreateSessionResponse> {
    let capability: SessionCapabilityProvision | undefined
    let provisionalSession: ActiveSession | undefined
    let reservation: ReturnType<AcpSessionRegistry['reserve']>['reservation']
    try {
      log.info('createSession: starting', this.deps.diagnosticContext())
      const cwd = resolve(request.cwd || this.deps.currentCwd() || this.deps.defaultCwd)
      const projectId = request.projectId?.trim() || this.deps.defaultProjectId
      log.info('createSession: ensureConnected', this.deps.diagnosticContext())
      const connection = await this.deps.ensureConnected(cwd)
      this.deps.assertCurrentConnection(connection)
      const startupBackend = this.deps.currentBackend()
      const startupGeneration = this.deps.registry.startupGeneration
      const specialist = await this.resolveSpecialist(request.specialistId, startupBackend)
      const projectContextAppend = await this.resolveProjectAgentContext(projectId)

      log.info('createSession: createMcpServers', this.deps.diagnosticContext())
      capability = await this.deps.capabilities.provision({
        framework: startupBackend.framework,
        nativeMcpEnabled: startupBackend.adapter.nativeMcpEnabled,
        bridgeMcpAliasesEnabled: startupBackend.adapter.bridgeMcpAliasesEnabled,
        policy: this.deps.capabilityPolicy,
        sessionCwd: cwd,
        projectId,
        memoryEnabled: request.memoryEnabled,
        literatureEnabled: request.literatureContext === true
      })
      const setup = this.presentation.buildSessionSetup({
        framework: startupBackend.framework,
        tooling: {
          artifacts: capability.descriptor.capabilities.includes('artifacts'),
          notebook: capability.descriptor.capabilities.includes('notebook'),
          skillImport: capability.descriptor.capabilities.includes('skill-import')
        },
        role: capability.descriptor.role,
        backendSystemPromptAppends: startupBackend.prompt.systemPromptAppends,
        extraSystemPromptAppends: [projectContextAppend, specialist.append].filter(
          (append): append is string => Boolean(append)
        ),
        persistentSystemPrompt: startupBackend.prompt.persistentSystemPrompt,
        sessionOptions: startupBackend.session.options,
        specialistSkills: specialist.skills
      })
      const sessionCapabilities = capability.includeFrameworkMcpServers(setup.mcpServers ?? [])
      log.info('createSession: buildSession', this.deps.diagnosticContext())
      const session = await connection.agent
        .buildSession({
          cwd,
          mcpServers: sessionCapabilities.mcpServers,
          ...setup.metaArg
        })
        .start()
      provisionalSession = session

      const reserved = this.deps.reserveIdentity(session.sessionId, startupGeneration)
      if (reserved.collision) {
        this.disposeProvisional(session, 'primary collision session disposal failed')
        provisionalSession = undefined
        throw reserved.collision
      }
      const identityReservation = reserved.reservation
      const provisionedCapability = capability
      reservation = identityReservation

      log.info('createSession: configurePermissionProfile', this.deps.diagnosticContext())
      log.info('createSession: applySessionModel', this.deps.diagnosticContext())
      const permissionProfile = normalizePermissionProfile(request.permissionProfile)
      let backend = this.deps.currentBackend()
      let configuration = await this.deps.configurator.configure({
        backend,
        connection,
        session,
        permissionProfile
      })
      for (;;) {
        // A live effort change can overlap the provider request above. Replay against the newest
        // immutable backend view until it is stable, then publish synchronously so the change either
        // precedes configuration or observes this Session in the Registry.
        const currentBackend = this.deps.currentBackend()
        if (currentBackend !== backend) {
          backend = currentBackend
          configuration = await this.deps.configurator.configure({
            backend,
            connection,
            session,
            permissionProfile
          })
          continue
        }
        identityReservation.assertCurrent()
        const { aggregate } = this.deps.registry.publish(identityReservation, session.sessionId, {
          session,
          cwd,
          projectId,
          frameworkId: backend.framework.id,
          backendId: backend.backendId,
          permissionProfile: structuredClone(configuration.permissionProfile),
          memoryEnabled: request.memoryEnabled !== false,
          appliedModel: configuration.appliedModel,
          configOptions: structuredClone(configuration.configOptions)
        })
        aggregate.setSessionSetupPromptPrefix(setup.promptPrefix)
        aggregate.setSpecialistPrefix(specialist.prefix || undefined)
        aggregate.setSpecialistId(request.specialistId)
        provisionedCapability.commit(session.sessionId)
        provisionalSession = undefined
        identityReservation.release()
        reservation = undefined
        capability = undefined
        break
      }

      this.publish(request, session.sessionId, cwd)
      log.info('createSession: completed successfully', this.deps.diagnosticContext())
      return {
        sessionId: session.sessionId,
        providerSessionId: session.sessionId,
        ...(backend.providerContinuityToken
          ? { providerContinuityToken: backend.providerContinuityToken }
          : {}),
        cwd,
        frameworkId: backend.framework.id,
        ...(backend.backendId ? { backendId: backend.backendId } : {})
      }
    } catch (caught) {
      let startupError = caught
      if (reservation) {
        try {
          reservation.assertCurrent()
        } catch (supersededError) {
          startupError = supersededError
        }
      }
      this.disposeProvisional(provisionalSession, 'primary startup session disposal failed')
      if (capability) {
        try {
          capability.release({ ownsStableIdentity: true })
        } catch (cleanupError) {
          this.safeLogError('primary capability release failed', cleanupError, undefined, false)
        }
      }
      this.safeLogError('createSession: failed', startupError)
      throw startupError
    } finally {
      reservation?.release()
    }
  }

  private async resolveProjectAgentContext(projectId: string): Promise<string | undefined> {
    if (!this.deps.resolveProjectAgentContext) return undefined
    const context = await this.deps.resolveProjectAgentContext(projectId)
    return this.presentation.projectAgentContext(context)
  }

  private async resolveSpecialist(
    specialistId: string | undefined,
    backend: AcpBackendGenerationView
  ): Promise<{ append?: string; prefix?: string; skills?: EffectiveSpecialistSkills }> {
    if (!specialistId) return {}
    if (!this.deps.resolveSpecialistIdentity) {
      throw new Error('Specialist identity resolution is unavailable.')
    }
    const identity = await this.deps.resolveSpecialistIdentity(specialistId, backend.framework.id)
    if (!identity) {
      throw new Error(`Specialist ${specialistId} is unavailable (disabled, deleted, or corrupt).`)
    }
    return {
      append: identity.append || undefined,
      prefix: identity.prefix || undefined,
      skills: await this.deps.resolveSpecialistSkills?.(specialistId)
    }
  }

  private publish(request: AcpCreateSessionRequest, sessionId: string, cwd: string): void {
    this.tryPostPublish(
      'register session specialist failed',
      () => this.deps.registerSessionSpecialist?.(sessionId, request.specialistId),
      sessionId
    )
    this.deps.updateCwd(cwd)
    this.tryPostPublish(
      'session created event callback failed',
      () =>
        this.deps.pushEvent({
          kind: 'system',
          level: 'info',
          sessionId,
          title: 'Session created',
          text: cwd
        }),
      sessionId
    )
    this.tryPostPublish('session created state callback failed', this.deps.emitState, sessionId)
  }

  private disposeProvisional(session: ActiveSession | undefined, message: string): void {
    if (!session) return
    try {
      session.dispose()
    } catch (error) {
      this.safeLogError(message, error, session.sessionId, false)
    }
  }

  private tryPostPublish(message: string, callback: () => void, sessionId: string): void {
    try {
      callback()
    } catch (error) {
      this.safeLogError(message, error, sessionId, false)
    }
  }

  private safeLogError(
    message: string,
    error: unknown,
    sessionId?: string,
    includeContext = true
  ): void {
    try {
      log.error(message, {
        ...diagnosticErrorFields(error),
        ...(includeContext ? this.deps.diagnosticContext() : {}),
        ...(sessionId ? { sessionId } : {})
      })
    } catch {
      // Diagnostics must never replace the provider or cleanup failure.
    }
  }
}
