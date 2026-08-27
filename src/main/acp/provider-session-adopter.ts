import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'

import type { AcpCreateSessionResponse } from '../../shared/acp'
import {
  normalizePermissionProfile,
  type PermissionProfileId
} from '../../shared/permission-profiles'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import { startDiagnosticOperation } from '../diagnostics/operation'
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
  AcpPrimarySessionIdentityReservation,
  AcpPrimarySessionIdentityReservationResult,
  AcpSessionRegistry
} from './session-registry'

const log = createLogger('acp')

type AcpProviderSessionAdoptionRequest = Readonly<{
  connection: ClientConnection
  cwd: string
  projectId: string
  // The enclosing resume/reset transaction transfers its opaque stable-ID reservation here after
  // reconnect renewal. Adoption owns extension, publication, and terminal release; the caller's
  // finally may release the same handle only as an idempotent fallback.
  identity: AcpPrimarySessionIdentityReservation
  permissionProfile?: PermissionProfileId
  specialistId?: string
  specialistBindingPending?: true
}>

type AcpProviderSessionAdopterDependencies = Readonly<{
  currentBackend: () => AcpBackendGenerationView
  registry: AcpSessionRegistry
  reserveIdentity: (
    reservation: AcpPrimarySessionIdentityReservation,
    sessionIds: string[]
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
  // session adoption.
  resolveProjectAgentContext?: (projectId: string) => Promise<string | undefined>
  peekClaudeReplay: (sessionId: string) => string | undefined
  commitClaudeReplay: (sessionId: string) => void
  updateCwd: (cwd: string) => void
  emitState: () => void
  diagnosticContext: () => Readonly<Record<string, unknown>>
}>

export class AcpProviderSessionAdopter {
  private readonly presentation = new AcpSessionPresentationPolicy()

  constructor(private readonly deps: AcpProviderSessionAdopterDependencies) {}

  async adopt(
    stableAppSessionId: string,
    request: AcpProviderSessionAdoptionRequest
  ): Promise<AcpCreateSessionResponse> {
    const diagnostics = startDiagnosticOperation(log, {
      operation: 'acp-provider-session-adoption',
      fields: {
        sessionId: stableAppSessionId,
        target: request.specialistId === undefined ? 'main-agent' : 'specialist'
      }
    })
    let capability: SessionCapabilityProvision | undefined
    let provisionalSession: ActiveSession | undefined
    let adoptedProviderSessionId: string | undefined
    let identity = request.identity
    try {
      const startupBackend = this.deps.currentBackend()
      diagnostics.phase('provision-capabilities', {
        frameworkId: startupBackend.framework.id
      })
      capability = await this.deps.capabilities.provision({
        stableAppSessionId,
        framework: startupBackend.framework,
        nativeMcpEnabled: startupBackend.adapter.nativeMcpEnabled,
        bridgeMcpAliasesEnabled: startupBackend.adapter.bridgeMcpAliasesEnabled,
        policy: this.deps.capabilityPolicy,
        sessionCwd: request.cwd,
        projectId: request.projectId
      })
      const hasAuthoritativeSpecialistBinding =
        request.specialistBindingPending === true || request.specialistId !== undefined
      const specialistId = hasAuthoritativeSpecialistBinding
        ? request.specialistId
        : this.deps.registry.lookup(stableAppSessionId)?.aggregate.snapshot().specialistId
      diagnostics.phase('resolve-specialist')
      const [specialistIdentity, specialistSkills] = await Promise.all([
        this.resolveSpecialistIdentity(specialistId, startupBackend),
        this.resolveSpecialistSkills(specialistId)
      ])
      const handoffAppend = this.deps.peekClaudeReplay(stableAppSessionId)
      diagnostics.phase('resolve-project-context')
      const projectContextAppend = await this.resolveProjectAgentContext(request.projectId)
      const setup = this.presentation.buildSessionSetup({
        framework: startupBackend.framework,
        tooling: {
          artifacts: capability.descriptor.capabilities.includes('artifacts'),
          notebook: capability.descriptor.capabilities.includes('notebook'),
          skillImport: capability.descriptor.capabilities.includes('skill-import')
        },
        role: capability.descriptor.role,
        backendSystemPromptAppends: startupBackend.prompt.systemPromptAppends,
        extraSystemPromptAppends: [
          handoffAppend,
          projectContextAppend,
          specialistIdentity?.append
        ].filter((append): append is string => Boolean(append)),
        persistentSystemPrompt: startupBackend.prompt.persistentSystemPrompt,
        sessionOptions: startupBackend.session.options,
        specialistSkills
      })
      diagnostics.phase('start-provider-session')
      provisionalSession = await request.connection.agent
        .buildSession({ cwd: request.cwd, mcpServers: capability.mcpServers, ...setup.metaArg })
        .start()
      adoptedProviderSessionId = provisionalSession.sessionId

      const reserved = this.deps.reserveIdentity(identity, [
        stableAppSessionId,
        provisionalSession.sessionId
      ])
      if (reserved.collision) {
        this.disposeProvisional(provisionalSession, 'primary collision session disposal failed')
        provisionalSession = undefined
        throw reserved.collision
      }
      identity = reserved.reservation

      const permissionProfile = normalizePermissionProfile(request.permissionProfile)
      let backend = this.deps.currentBackend()
      diagnostics.phase('configure-provider-session')
      let configuration = await this.deps.configurator.configure({
        backend,
        connection: request.connection,
        session: provisionalSession,
        permissionProfile
      })
      for (;;) {
        // Live effort may change outside the operation lease. Replay against the newest immutable
        // generation view before synchronous publication, matching fresh creation semantics.
        const currentBackend = this.deps.currentBackend()
        if (currentBackend !== backend) {
          backend = currentBackend
          configuration = await this.deps.configurator.configure({
            backend,
            connection: request.connection,
            session: provisionalSession,
            permissionProfile
          })
          continue
        }
        diagnostics.phase('publish-provider-session')
        identity.assertCurrent()
        const { aggregate } = this.deps.registry.publish(identity, stableAppSessionId, {
          session: provisionalSession,
          cwd: request.cwd,
          projectId: request.projectId,
          frameworkId: backend.framework.id,
          backendId: backend.backendId,
          permissionProfile: structuredClone(configuration.permissionProfile),
          appliedModel: configuration.appliedModel,
          configOptions: structuredClone(configuration.configOptions)
        })
        aggregate.setSessionSetupPromptPrefix(setup.promptPrefix)
        this.deps.updateCwd(request.cwd)
        if (specialistIdentity) {
          aggregate.setSpecialistPrefix(specialistIdentity.prefix || undefined)
        } else if (!specialistId) {
          aggregate.setSpecialistPrefix(undefined)
        }
        if (hasAuthoritativeSpecialistBinding) aggregate.setSpecialistId(specialistId)
        capability.commit(stableAppSessionId)
        this.deps.commitClaudeReplay(stableAppSessionId)
        provisionalSession = undefined
        capability = undefined
        identity.release()
        break
      }

      try {
        this.deps.emitState()
      } catch (error) {
        this.safeLogError('adopted session state callback failed', error, stableAppSessionId)
      }
      diagnostics.complete({ frameworkId: backend.framework.id })
      return {
        sessionId: stableAppSessionId,
        ...(adoptedProviderSessionId ? { providerSessionId: adoptedProviderSessionId } : {}),
        ...(backend.providerContinuityToken
          ? { providerContinuityToken: backend.providerContinuityToken }
          : {}),
        cwd: request.cwd,
        frameworkId: backend.framework.id,
        ...(backend.backendId ? { backendId: backend.backendId } : {}),
        contextReset: true
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
      if (capability) {
        try {
          capability.release({ ownsStableIdentity })
        } catch (cleanupError) {
          this.safeLogError('adopted capability release failed', cleanupError, stableAppSessionId)
        }
      }
      this.disposeProvisional(provisionalSession, 'adopted startup session disposal failed')
      diagnostics.fail(startupError)
      throw startupError
    } finally {
      identity.release()
    }
  }

  private async resolveProjectAgentContext(projectId: string): Promise<string | undefined> {
    if (!this.deps.resolveProjectAgentContext) return undefined
    const context = await this.deps.resolveProjectAgentContext(projectId)
    return this.presentation.projectAgentContext(context)
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

export type { AcpProviderSessionAdoptionRequest }
