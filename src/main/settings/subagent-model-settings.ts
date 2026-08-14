import type { ReviewerModelConfiguration, SubagentModelConfiguration } from '../../shared/settings'
import type { StoredSettings } from './types'

type SubagentModelValidator = (
  settings: StoredSettings,
  configuration: SubagentModelConfiguration
) => SubagentModelConfiguration | void

type ReviewerModelValidator = (
  settings: StoredSettings,
  configuration: ReviewerModelConfiguration
) => ReviewerModelConfiguration | void

const buildSubagentModelMutation =
  (configuration: SubagentModelConfiguration, validate?: SubagentModelValidator) =>
  (settings: StoredSettings): StoredSettings => ({
    ...settings,
    subagentModel: structuredClone(validate?.(settings, configuration) ?? configuration)
  })

const buildReviewerModelMutation =
  (configuration: ReviewerModelConfiguration, validate?: ReviewerModelValidator) =>
  (settings: StoredSettings): StoredSettings => ({
    ...settings,
    reviewerModel: structuredClone(validate?.(settings, configuration) ?? configuration)
  })

export { buildReviewerModelMutation, buildSubagentModelMutation }
export type { ReviewerModelValidator, SubagentModelValidator }
