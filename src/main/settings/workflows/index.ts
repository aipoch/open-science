import {
  AppearanceSettingsWorkflows,
  type AppearanceSettingsWorkflowEffects,
  type AppearanceSettingsWorkflowStore
} from './appearance'
import {
  ConnectorSettingsWorkflows,
  type ConnectorSettingsWorkflowEffects,
  type ConnectorSettingsWorkflowStore
} from './connectors'
import {
  RuntimeSettingsWorkflows,
  type RuntimeSettingsWorkflowEffects,
  type RuntimeSettingsWorkflowStore
} from './runtime'
import {
  SkillSettingsWorkflows,
  type SkillSettingsWorkflowEffects,
  type SkillSettingsWorkflowStore
} from './skills'

type SettingsWorkflowStore = RuntimeSettingsWorkflowStore &
  SkillSettingsWorkflowStore &
  ConnectorSettingsWorkflowStore &
  AppearanceSettingsWorkflowStore

type SettingsWorkflowEffects = {
  runtime: RuntimeSettingsWorkflowEffects
  skills: SkillSettingsWorkflowEffects
  connectors: ConnectorSettingsWorkflowEffects
  appearance: AppearanceSettingsWorkflowEffects
}

type SettingsWorkflows = {
  runtime: RuntimeSettingsWorkflows
  skills: SkillSettingsWorkflows
  connectors: ConnectorSettingsWorkflows
  appearance: AppearanceSettingsWorkflows
}

// The factory is composition only: each domain workflow owns a narrow store/effect port and can
// evolve independently without turning Settings mutations into one cross-domain change magnet.
const createSettingsWorkflows = (
  settings: SettingsWorkflowStore,
  effects: SettingsWorkflowEffects
): SettingsWorkflows => ({
  runtime: new RuntimeSettingsWorkflows(settings, effects.runtime),
  skills: new SkillSettingsWorkflows(settings, effects.skills),
  connectors: new ConnectorSettingsWorkflows(settings, effects.connectors),
  appearance: new AppearanceSettingsWorkflows(settings, effects.appearance)
})

export { createSettingsWorkflows }
export type { SettingsWorkflowEffects, SettingsWorkflowStore, SettingsWorkflows }
