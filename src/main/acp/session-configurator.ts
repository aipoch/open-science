import * as acp from '@agentclientprotocol/sdk'
import type { ActiveSession, ClientConnection, SessionConfigOption } from '@agentclientprotocol/sdk'

import type {
  PermissionProfileId,
  SessionPermissionProfileState
} from '../../shared/permission-profiles'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import {
  matchSessionModelOption,
  resolveSessionEffortOption,
  type SessionModelSelection
} from './session-config'

const log = createLogger('acp')

type ConfigurationContext = Readonly<{
  backend: AcpBackendGenerationView
  connection: ClientConnection
}>
type StartupConfiguration = ConfigurationContext &
  Readonly<{ session: ActiveSession; permissionProfile: PermissionProfileId }>
type LiveEffortSession = Readonly<{
  session: ActiveSession
  configOptions: readonly SessionConfigOption[] | null | undefined
  assertCurrent: () => void
}>
type LiveEffortConfiguration = ConfigurationContext &
  Readonly<{
    effort: ResolvedReasoningEffort
    sessions: readonly LiveEffortSession[]
  }>
type ModelApplication = Readonly<{
  appliedModel: string | undefined
  configOptions: SessionConfigOption[] | null | undefined
}>
export type AcpSessionConfigurationFacts = Readonly<{
  permissionProfile: SessionPermissionProfileState
  appliedModel: string | undefined
  configOptions: SessionConfigOption[] | undefined
}>
export type AcpLiveEffortConfigurationFacts = Readonly<{
  reconnectRequired: boolean
}>
const configOptionsOf = (session: ActiveSession): SessionConfigOption[] | null | undefined =>
  (session as { newSessionResponse?: { configOptions?: SessionConfigOption[] | null } })
    .newSessionResponse?.configOptions

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

// Statelessly sequences provider Session configuration; callers retain every ownership commit.
export class AcpSessionConfigurator {
  constructor(
    private readonly deps: Readonly<{
      assertCurrentConnection: (connection: ClientConnection) => void
      diagnosticContext: (backend: AcpBackendGenerationView) => Readonly<Record<string, unknown>>
    }>
  ) {}

  async configure(input: StartupConfiguration): Promise<AcpSessionConfigurationFacts> {
    const permissionState = await this.applyPermissionMode(input)
    const modelApplication = await this.applyModel(input)
    const effort = input.backend.session.effort
    if (effort) {
      const selection = resolveSessionEffortOption(
        modelApplication.configOptions ?? configOptionsOf(input.session),
        effort,
        input.backend.framework.adaptSessionEffort
      )
      if (selection) await this.sendEffort(input, input.session, selection)
      else log.info('no session effort option to apply', this.deps.diagnosticContext(input.backend))
    }

    return deepFreeze({
      permissionProfile: structuredClone(permissionState),
      appliedModel: modelApplication.appliedModel,
      configOptions:
        modelApplication.configOptions == null
          ? undefined
          : structuredClone(modelApplication.configOptions)
    })
  }

  async configurePermissionProfile(
    input: StartupConfiguration,
    forcePermissionMode = false
  ): Promise<Readonly<SessionPermissionProfileState>> {
    return deepFreeze(structuredClone(await this.applyPermissionMode(input, forcePermissionMode)))
  }

  async applyLiveEffort(input: LiveEffortConfiguration): Promise<AcpLiveEffortConfigurationFacts> {
    if (!input.backend.framework.supportsLiveEffortChange) {
      return deepFreeze({ reconnectRequired: true })
    }
    let reconnectRequired = false
    let appliedToAny = false
    for (const candidate of input.sessions) {
      const selection = resolveSessionEffortOption(
        candidate.configOptions,
        input.effort,
        input.backend.framework.adaptSessionEffort
      )
      if (!selection) {
        log.info('no session effort option to apply', this.deps.diagnosticContext(input.backend))
        continue
      }
      try {
        candidate.assertCurrent()
        if (await this.sendEffort(input, candidate.session, selection)) appliedToAny = true
        else reconnectRequired = true
      } catch (error) {
        log.warn('set session effort failed', {
          ...diagnosticErrorFields(error),
          ...this.deps.diagnosticContext(input.backend)
        })
        reconnectRequired = true
      }
    }
    if (!appliedToAny && input.sessions.length > 0 && input.backend.framework.id === 'codex') {
      reconnectRequired = true
    }
    return deepFreeze({ reconnectRequired })
  }

  private async applyPermissionMode(
    input: StartupConfiguration,
    forcePermissionMode = false
  ): Promise<SessionPermissionProfileState> {
    const application = input.backend.framework.mapPermissionProfile(
      input.permissionProfile,
      input.session.modes
    )
    if (
      application.modeId &&
      (forcePermissionMode || application.modeId !== input.session.modes?.currentModeId)
    ) {
      this.deps.assertCurrentConnection(input.connection)
      await input.connection.agent.request(acp.methods.agent.session.setMode, {
        sessionId: input.session.sessionId,
        modeId: application.modeId
      })
    }
    log.info('permission profile applied', this.deps.diagnosticContext(input.backend))
    return application.state
  }

  private async applyModel(input: StartupConfiguration): Promise<ModelApplication> {
    const model = input.backend.session.model
    if (!model) return { appliedModel: undefined, configOptions: undefined }
    const configOptions = configOptionsOf(input.session)
    const selection = matchSessionModelOption(configOptions, model)

    if (!selection) {
      log.info('no matching session model option', this.deps.diagnosticContext(input.backend))
      if (input.backend.session.modelRequired) {
        throw new Error(`The selected model "${model}" is not available for this Codex account.`)
      }
      return { appliedModel: undefined, configOptions: undefined }
    }
    if (selection.alreadyCurrent) {
      log.info('session model already current', this.deps.diagnosticContext(input.backend))
      return { appliedModel: selection.value, configOptions: configOptions ?? null }
    }

    this.deps.assertCurrentConnection(input.connection)
    try {
      const response = (await input.connection.agent.request(
        acp.methods.agent.session.setConfigOption,
        { sessionId: input.session.sessionId, configId: selection.configId, value: selection.value }
      )) as { configOptions?: SessionConfigOption[] | null }
      log.info('session model applied', this.deps.diagnosticContext(input.backend))
      return {
        appliedModel: selection.value,
        configOptions: response?.configOptions ?? configOptions
      }
    } catch (error) {
      log.warn('set session model failed', {
        ...diagnosticErrorFields(error),
        ...this.deps.diagnosticContext(input.backend)
      })
      if (input.backend.session.modelRequired) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`The selected model "${model}" could not be applied: ${message}`)
      }
      return { appliedModel: undefined, configOptions: undefined }
    }
  }

  private async sendEffort(
    input: ConfigurationContext,
    session: ActiveSession,
    selection: SessionModelSelection
  ): Promise<boolean> {
    this.deps.assertCurrentConnection(input.connection)
    try {
      await input.connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: selection.configId,
        value: selection.value
      })
      log.info('session effort applied', this.deps.diagnosticContext(input.backend))
      return true
    } catch (error) {
      log.warn('set session effort failed', {
        ...diagnosticErrorFields(error),
        ...this.deps.diagnosticContext(input.backend)
      })
      return false
    }
  }
}
