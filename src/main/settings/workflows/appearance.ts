import type { AppIconVariant } from '../../../shared/settings'
import type { SettingsService } from '../service'

type AppearanceSettingsWorkflowStore = Pick<SettingsService, 'setAppIconVariant'>

type AppearanceSettingsWorkflowEffects = {
  applyAppIconVariant: (variant: AppIconVariant) => void
}

// Owns the post-persistence native icon effect without coupling Appearance to runtime workflows.
class AppearanceSettingsWorkflows {
  constructor(
    private readonly settings: AppearanceSettingsWorkflowStore,
    private readonly effects: AppearanceSettingsWorkflowEffects
  ) {}

  async setAppIconVariant(
    variant: AppIconVariant
  ): Promise<Awaited<ReturnType<AppearanceSettingsWorkflowStore['setAppIconVariant']>>> {
    const snapshot = await this.settings.setAppIconVariant(variant)
    this.effects.applyAppIconVariant(variant)
    return snapshot
  }
}

export { AppearanceSettingsWorkflows }
export type { AppearanceSettingsWorkflowEffects, AppearanceSettingsWorkflowStore }
