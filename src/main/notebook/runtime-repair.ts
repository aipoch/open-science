import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookEnvironmentOperations } from './environment-operations'
import type { NotebookPackageAdmittedTarget } from './package-admission'
import type { NotebookRuntimeBindingOwner } from './runtime-binding'
import { notebookLaneKey } from './lane-identity'
import {
  addRepairRequired,
  clearRepairRequired,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  readRepairRequiredReason,
  resolveEnvName
} from './runtime-paths'
import type { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import type { NotebookSessionAggregate, NotebookSessionRuntimeBinding } from './session-aggregate'

const REPAIR_QUARANTINE_FAILED = 'REPAIR_QUARANTINE_FAILED'

export type ExplicitRuntimeRepairTarget =
  | Readonly<{ kind: 'default-environment'; environmentName: string }>
  | Readonly<{ kind: 'runtime'; runtimeId: string }>

type RuntimeRepairScope = Readonly<{
  language: NotebookLanguage
  environmentName: string
  binding?: NotebookSessionRuntimeBinding
}>

type RepairSession = NotebookSessionAggregate

type NotebookRuntimeRepairOwnerOptions = {
  runtimeRoot: string
  policy: Pick<NotebookRuntimeRepairPolicy, 'blockKey' | 'registryKeys'>
  bindings: Pick<
    NotebookRuntimeBindingOwner,
    'runWrites' | 'markUnavailable' | 'markAvailable' | 'persist' | 'persistStrict'
  >
  environmentOperations: Pick<NotebookEnvironmentOperations, 'blockRepair' | 'clearRepair'>
  sessions: () => Iterable<RepairSession>
  isCurrentSession: (session: RepairSession) => boolean
  clearKernelTermination: (session: RepairSession, processKey: string) => Promise<void>
  notifyChanged: (session: RepairSession) => void
}

const defaultEnvironment = (language: NotebookLanguage): string =>
  language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV

export const explicitRuntimeRepairTarget = (
  language: NotebookLanguage,
  runtimeIdentity: string
): ExplicitRuntimeRepairTarget => {
  const environmentName = defaultEnvironment(language)
  return runtimeIdentity === environmentName
    ? { kind: 'default-environment', environmentName }
    : { kind: 'runtime', runtimeId: runtimeIdentity }
}

const processKey = (language: NotebookLanguage, environment: string): string =>
  `${language === 'r' ? 'r' : 'python'}:${resolveEnvName(language, environment)}`

/** Owns runtime quarantine and repaired-binding restoration without exposing Session state. */
class NotebookRuntimeRepairOwner {
  constructor(private readonly options: NotebookRuntimeRepairOwnerOptions) {}

  async prepareExplicitRepair(
    language: NotebookLanguage,
    binding?: NotebookSessionRuntimeBinding
  ): Promise<void> {
    const environmentName = defaultEnvironment(language)
    const target = { language, environmentName, binding } satisfies RuntimeRepairScope
    const affectedLanguages = ['python', 'r'] as const
    const sessions = Array.from(this.options.sessions())
    const repairKeys = new Set(this.options.policy.registryKeys(language, environmentName, binding))
    for (const session of sessions) {
      for (const [boundLanguage, boundBinding] of session.runtimeBindingEntries()) {
        if (!this.matches(session, boundLanguage, target, true)) continue
        for (const key of this.options.policy.registryKeys(
          boundLanguage,
          environmentName,
          boundBinding
        )) {
          repairKeys.add(key)
        }
      }
    }
    for (const affectedLanguage of affectedLanguages) {
      this.options.environmentOperations.blockRepair(
        this.options.policy.blockKey(affectedLanguage, environmentName)
      )
    }
    for (const key of repairKeys) {
      addRepairRequired(this.options.runtimeRoot, key, 'protected-identity-change')
    }

    await this.options.bindings.runWrites(
      sessions.map((session) => notebookLaneKey(session.lane)),
      async () => {
        const changed = new Set<RepairSession>()
        for (const session of sessions) {
          if (!this.options.isCurrentSession(session)) continue
          for (const affectedLanguage of affectedLanguages) {
            if (!this.matches(session, affectedLanguage, target, true)) continue
            if (
              session.runtimeBinding(affectedLanguage) &&
              this.options.bindings.markUnavailable(session, affectedLanguage, 'repair-required')
            ) {
              changed.add(session)
            }
          }
        }
        for (const session of changed) await this.options.bindings.persistStrict(session)

        for (const session of sessions) {
          if (!this.options.isCurrentSession(session)) continue
          for (const affectedLanguage of affectedLanguages) {
            if (!this.matches(session, affectedLanguage, target, true)) continue
            const environment = this.environmentFor(session, affectedLanguage)
            const key = processKey(affectedLanguage, environment)
            if (session.kernelStatus(key) === 'running') session.markForceStopped(key)
            await session.terminateExecutor(affectedLanguage === 'r' ? 'r' : 'python', environment)
            await this.options.clearKernelTermination(session, key)
            session.clearProcessState(key)
            this.options.notifyChanged(session)
          }
        }
      }
    )
  }

  async quarantineProtectedIdentity(target: NotebookPackageAdmittedTarget): Promise<void> {
    const repairTarget = this.target(target)
    const managed = repairTarget.binding?.source !== 'external'
    const languages: readonly NotebookLanguage[] = managed
      ? ['python', 'r']
      : [repairTarget.language]
    const sessions = Array.from(this.options.sessions())
    await this.options.bindings.runWrites(
      sessions.map((session) => notebookLaneKey(session.lane)),
      async () => {
        const changed = new Set<RepairSession>()
        if (managed) {
          for (const language of languages) {
            this.options.environmentOperations.blockRepair(
              this.options.policy.blockKey(language, repairTarget.environmentName)
            )
          }
        } else {
          this.options.environmentOperations.blockRepair(this.blockKey(repairTarget))
        }
        try {
          for (const session of sessions) {
            if (!this.options.isCurrentSession(session)) continue
            for (const language of languages) {
              if (!this.matches(session, language, repairTarget, managed)) continue
              if (
                session.runtimeBinding(language) &&
                this.options.bindings.markUnavailable(session, language, 'repair-required')
              ) {
                changed.add(session)
              }
              const environment = this.environmentFor(session, language)
              await session.terminateExecutor(language === 'r' ? 'r' : 'python', environment)
              session.clearProcessState(processKey(language, environment))
              this.options.notifyChanged(session)
            }
          }
          addRepairRequired(
            this.options.runtimeRoot,
            target.repairRuntimeId,
            'protected-identity-change'
          )
          for (const session of changed) await this.options.bindings.persist(session)
        } catch (error) {
          throw new Error(
            `${REPAIR_QUARANTINE_FAILED}: could not durably quarantine the runtime after its protected ` +
              `interpreter changed. ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        }
      }
    )
  }

  async completeInterruptedInstall(target: NotebookPackageAdmittedTarget): Promise<void> {
    const repairTarget = this.target(target)
    const managed = repairTarget.binding?.source !== 'external'

    // The admitted marker is the operation's authoritative repair identity. Clearing it also adopts
    // a successful external install from legacy registries, while managed legacy markers never reach
    // this callback because admission and its post-lock recheck keep them fail-closed.
    clearRepairRequired(this.options.runtimeRoot, target.repairMarkerKey)
    if (managed) {
      const aliases = this.registryKeys(repairTarget)
      aliases.delete(repairTarget.environmentName)
      aliases.delete(target.repairMarkerKey)
      for (const session of this.options.sessions()) {
        if (!this.matches(session, repairTarget.language, repairTarget, false)) continue
        const binding = session.runtimeBinding(repairTarget.language)
        if (binding) aliases.add(binding.runtimeId)
      }
      for (const alias of aliases) {
        if (readRepairRequiredReason(this.options.runtimeRoot, alias) === 'interrupted-install') {
          clearRepairRequired(this.options.runtimeRoot, alias)
        }
      }
    } else {
      this.options.environmentOperations.clearRepair(this.blockKey(repairTarget))
    }
    await this.restoreBindings(repairTarget, false)
  }

  async completeExplicitRepair(
    language: NotebookLanguage,
    replacement: NotebookSessionRuntimeBinding
  ): Promise<void> {
    const environmentName = defaultEnvironment(language)
    const target = { language, environmentName } satisfies RuntimeRepairScope
    const aliases = new Set(this.options.policy.registryKeys(language, environmentName))
    for (const session of this.options.sessions()) {
      for (const [boundLanguage, binding] of session.runtimeBindingEntries()) {
        if (!this.matches(session, boundLanguage, target, false)) continue
        for (const key of this.options.policy.registryKeys(
          boundLanguage,
          environmentName,
          binding
        )) {
          aliases.add(key)
        }
      }
    }

    const sessions = Array.from(this.options.sessions())
    await this.options.bindings.runWrites(
      sessions.map((session) => notebookLaneKey(session.lane)),
      async () => {
        for (const session of sessions) {
          if (!this.options.isCurrentSession(session)) continue
          if (!this.matches(session, language, target, false)) continue
          const previous = session.runtimeBinding(language)
          if (!previous) continue
          session.setRuntimeBinding(language, replacement)
          try {
            await this.options.bindings.persistStrict(session)
          } catch (error) {
            session.setRuntimeBinding(language, previous)
            throw error
          }
        }
      }
    )

    // Keep the primary durable gate armed until refreshed bindings are durable and every compatibility
    // alias has been cleared. If any step fails, execution remains blocked and Reset can be retried.
    for (const alias of aliases) clearRepairRequired(this.options.runtimeRoot, alias)
    this.options.environmentOperations.clearRepair(
      this.options.policy.blockKey(language, environmentName)
    )
    for (const session of sessions) this.options.notifyChanged(session)
  }

  completeRemovedManagedEnvironment(environmentName: string): void {
    const target = { language: 'python', environmentName } satisfies RuntimeRepairScope
    const aliases = new Set<string>()
    for (const language of ['python', 'r'] as const) {
      for (const key of this.options.policy.registryKeys(language, environmentName))
        aliases.add(key)
      this.options.environmentOperations.clearRepair(
        this.options.policy.blockKey(language, environmentName)
      )
    }
    for (const session of this.options.sessions()) {
      for (const [language, binding] of session.runtimeBindingEntries()) {
        if (this.matches(session, language, target, true)) aliases.add(binding.runtimeId)
      }
    }
    for (const alias of aliases) clearRepairRequired(this.options.runtimeRoot, alias)
  }

  private target(target: NotebookPackageAdmittedTarget): RuntimeRepairScope {
    return {
      language: target.request.language,
      environmentName: target.environmentName,
      binding: target.binding
    }
  }

  private registryKeys(target: RuntimeRepairScope): Set<string> {
    return new Set(
      this.options.policy.registryKeys(target.language, target.environmentName, target.binding)
    )
  }

  private blockKey(target: RuntimeRepairScope): string {
    return this.options.policy.blockKey(target.language, target.environmentName, target.binding)
  }

  private environmentFor(session: RepairSession, language: NotebookLanguage): string {
    const binding = session.runtimeBinding(language)
    return binding?.source === 'managed' && binding.envName
      ? binding.envName
      : defaultEnvironment(language)
  }

  private matches(
    session: RepairSession,
    language: NotebookLanguage,
    target: RuntimeRepairScope,
    crossLanguage: boolean
  ): boolean {
    const binding = session.runtimeBinding(language)
    if (target.binding?.source === 'external') {
      return (
        language === target.language &&
        binding?.source === 'external' &&
        binding.runtimeId === target.binding.runtimeId
      )
    }
    return (
      (crossLanguage || language === target.language) &&
      binding?.source !== 'external' &&
      this.environmentFor(session, language) === target.environmentName
    )
  }

  private async restoreBindings(target: RuntimeRepairScope, crossLanguage: boolean): Promise<void> {
    const sessions = Array.from(this.options.sessions())
    await this.options.bindings.runWrites(
      sessions.map((session) => notebookLaneKey(session.lane)),
      async () => {
        const changedSessions: RepairSession[] = []
        for (const session of sessions) {
          if (!this.options.isCurrentSession(session)) continue
          let changed = false
          for (const [language, binding] of session.runtimeBindingEntries()) {
            if (
              binding.reason === 'repair-required' &&
              this.matches(session, language, target, crossLanguage)
            ) {
              changed = this.options.bindings.markAvailable(session, language) || changed
            }
          }
          if (changed) changedSessions.push(session)
        }
        for (const session of changedSessions) {
          await this.options.bindings.persist(session)
          this.options.notifyChanged(session)
        }
      }
    )
  }
}

export { NotebookRuntimeRepairOwner }
