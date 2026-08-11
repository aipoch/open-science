import type { SubagentModelConfiguration } from '../../shared/settings'
import type { StoredSettings } from './types'

type SubagentModelValidator = (
  settings: StoredSettings,
  configuration: SubagentModelConfiguration
) => SubagentModelConfiguration | void

const buildSubagentModelMutation =
  (configuration: SubagentModelConfiguration, validate?: SubagentModelValidator) =>
  (settings: StoredSettings): StoredSettings => ({
    ...settings,
    subagentModel: structuredClone(validate?.(settings, configuration) ?? configuration)
  })

export { buildSubagentModelMutation }
export type { SubagentModelValidator }
