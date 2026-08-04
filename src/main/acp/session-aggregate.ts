import type { ActiveSession, SessionConfigOption } from '@agentclientprotocol/sdk'

import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import type { AgentFrameworkId } from '../../shared/settings'

type AcpSessionAggregateAttachInput = {
  session: ActiveSession
  cwd: string
  projectName: string
  frameworkId: AgentFrameworkId
  backendId?: string
  permissionProfile: SessionPermissionProfileState
  appliedModel?: string
  configOptions?: SessionConfigOption[] | null
}

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value

type AcpSessionAggregateSnapshot = DeepReadonly<{
  providerSessionId?: string
  cwd?: string
  projectName?: string
  frameworkId?: AgentFrameworkId
  backendId?: string
  permissionProfile?: SessionPermissionProfileState
  specialistId?: string
  specialistPrefix?: string
  appliedModel?: string
  configOptions?: SessionConfigOption[]
}>

const cloneConfigOptions = (
  configOptions: SessionConfigOption[] | null | undefined
): SessionConfigOption[] | undefined =>
  configOptions === null || configOptions === undefined ? undefined : structuredClone(configOptions)

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object') return value
  for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
  return Object.freeze(value)
}

class AcpSessionAggregate {
  private session: ActiveSession | undefined
  private cwd: string | undefined
  private projectName: string | undefined
  private frameworkId: AgentFrameworkId | undefined
  private backendId: string | undefined
  private permissionProfile: SessionPermissionProfileState | undefined
  private specialistId: string | undefined
  private specialistPrefix: string | undefined
  private appliedModel: string | undefined
  private configOptions: SessionConfigOption[] | undefined
  private snapshotValue: AcpSessionAggregateSnapshot

  constructor(readonly appSessionId: string) {
    this.snapshotValue = this.buildSnapshot()
  }

  activeSession(): ActiveSession | undefined {
    return this.session
  }

  snapshot(): AcpSessionAggregateSnapshot {
    return this.snapshotValue
  }

  private buildSnapshot(): AcpSessionAggregateSnapshot {
    return deepFreeze({
      providerSessionId: this.session?.sessionId,
      cwd: this.cwd,
      projectName: this.projectName,
      frameworkId: this.frameworkId,
      backendId: this.backendId,
      permissionProfile:
        this.permissionProfile === undefined ? undefined : structuredClone(this.permissionProfile),
      specialistId: this.specialistId,
      specialistPrefix: this.specialistPrefix,
      appliedModel: this.appliedModel,
      configOptions: cloneConfigOptions(this.configOptions)
    })
  }

  private refreshSnapshot(): void {
    this.snapshotValue = this.buildSnapshot()
  }

  attach(input: AcpSessionAggregateAttachInput): ActiveSession | undefined {
    const previous = this.session
    this.session = input.session
    this.cwd = input.cwd
    this.projectName = input.projectName
    this.frameworkId = input.frameworkId
    if (input.backendId !== undefined) this.backendId = input.backendId
    this.permissionProfile = structuredClone(input.permissionProfile)
    this.appliedModel = input.appliedModel
    this.configOptions = cloneConfigOptions(input.configOptions)
    this.refreshSnapshot()
    return previous
  }

  updateLocation(cwd: string, projectName: string): void {
    this.cwd = cwd
    this.projectName = projectName
    this.refreshSnapshot()
  }

  setPermissionProfile(state: SessionPermissionProfileState | undefined): void {
    this.permissionProfile = state === undefined ? undefined : structuredClone(state)
    this.refreshSnapshot()
  }

  setSpecialistId(id: string | undefined): void {
    this.specialistId = id
    this.refreshSnapshot()
  }

  setSpecialistPrefix(prefix: string | undefined): void {
    this.specialistPrefix = prefix
    this.refreshSnapshot()
  }

  clearAppliedModel(): void {
    this.appliedModel = undefined
    this.refreshSnapshot()
  }

  updateModel(
    appliedModel: string,
    configOptions: SessionConfigOption[] | null | undefined,
    backendId?: string
  ): void {
    if (backendId !== undefined) this.backendId = backendId
    this.appliedModel = appliedModel
    this.configOptions = cloneConfigOptions(configOptions)
    this.refreshSnapshot()
  }

  detachProvider(): void {
    this.session = undefined
    this.appliedModel = undefined
    this.configOptions = undefined
    this.refreshSnapshot()
  }

  detachConnection(): void {
    this.session = undefined
    this.appliedModel = undefined
    this.configOptions = undefined
    this.cwd = undefined
    this.projectName = undefined
    this.refreshSnapshot()
  }
}

export { AcpSessionAggregate }
export type { AcpSessionAggregateAttachInput, AcpSessionAggregateSnapshot }
