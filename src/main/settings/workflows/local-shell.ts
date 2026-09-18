import type {
  SwitchToPowerShellResult,
  UseWsl2BashResult,
  WslSetupSnapshot,
  WslSelection
} from '../../../shared/wsl-setup'
import type { LocalShellRuntimeMutation } from '../local-shell-runtime-mutation'

type LocalShellRuntimeWorkflowWrite<Result> = Readonly<{
  result: Result
  mutation: LocalShellRuntimeMutation
}>

type LocalShellSettingsWorkflowStore = {
  switchLocalShellToPowerShell(): Promise<LocalShellRuntimeWorkflowWrite<SwitchToPowerShellResult>>
  useWsl2Bash(): Promise<LocalShellRuntimeWorkflowWrite<UseWsl2BashResult>>
  restoreLocalShellRuntimePreference(mutation: LocalShellRuntimeMutation): Promise<boolean>
}

type LocalShellSettingsWorkflowEffects = {
  requestShellRuntimeRefresh: () => Promise<void>
}

// Owns the persistence-before-refresh boundary for Shell backend changes. Global generation
// invalidation stops new work from observing the old binding while existing admitted work drains;
// a failed invalidation conditionally restores the preference that was current before this action.
class LocalShellSettingsWorkflows {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly settings: LocalShellSettingsWorkflowStore,
    private readonly effects: LocalShellSettingsWorkflowEffects
  ) {}

  async switchToPowerShell(): Promise<SwitchToPowerShellResult> {
    return this.enqueueSwitch(() =>
      this.switchRuntime(() => this.settings.switchLocalShellToPowerShell())
    )
  }

  async useWsl2Bash(): Promise<UseWsl2BashResult> {
    return this.enqueueSwitch(() => this.switchRuntime(() => this.settings.useWsl2Bash()))
  }

  async fallbackAfterWslProbe(
    snapshot: WslSetupSnapshot,
    readCurrent: () => Promise<{
      localShellRuntime?: 'powershell' | 'wsl2-bash'
      activatedWslSelection?: WslSelection
    }>
  ): Promise<boolean> {
    // Only a completed inventory establishes that the active distro was removed. A failed
    // candidate probe or transient command failure says nothing about the active profile.
    if (
      snapshot.errorCode !== 'wsl_distro_not_found' &&
      snapshot.errorCode !== 'wsl_distro_missing' &&
      snapshot.errorCode !== 'wsl_not_installed'
    )
      return false
    return this.enqueueSwitch(async () => {
      const current = await readCurrent()
      if (current.localShellRuntime !== 'wsl2-bash') return false
      const active = current.activatedWslSelection
      if (active && snapshot.distros.some((distro) => distro.name === active.distro)) return false
      await this.switchRuntime(() => this.settings.switchLocalShellToPowerShell())
      return true
    })
  }

  private async switchRuntime<Result>(
    persist: () => Promise<LocalShellRuntimeWorkflowWrite<Result>>
  ): Promise<Result> {
    const write = await persist()
    try {
      await this.effects.requestShellRuntimeRefresh()
      return write.result
    } catch (error) {
      const recoveryErrors: unknown[] = [error]
      try {
        const restored = await this.settings.restoreLocalShellRuntimePreference(write.mutation)
        if (!restored) {
          recoveryErrors.push(
            new Error(
              'The saved Shell preference changed before rollback could claim its mutation.'
            )
          )
        }
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError)
      }
      try {
        await this.effects.requestShellRuntimeRefresh()
      } catch (rollbackRefreshError) {
        recoveryErrors.push(rollbackRefreshError)
      }
      if (recoveryErrors.length > 1) {
        throw new AggregateError(
          recoveryErrors,
          'Shell capability refresh failed while restoring the saved preference.'
        )
      }
      throw error
    }
  }

  private enqueueSwitch<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export { LocalShellSettingsWorkflows }
export type { LocalShellSettingsWorkflowEffects, LocalShellSettingsWorkflowStore }
