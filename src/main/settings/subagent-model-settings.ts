import type {
  ReviewerModelConfiguration,
  SessionDetailsModelConfiguration,
  SubagentModelConfiguration,
  VisionModelConfiguration
} from '../../shared/settings'
import type { StoredSettings } from './types'

type SubagentModelValidator = (
  settings: StoredSettings,
  configuration: SubagentModelConfiguration
) => SubagentModelConfiguration | void

type ReviewerModelValidator = (
  settings: StoredSettings,
  configuration: ReviewerModelConfiguration
) => ReviewerModelConfiguration | void

type VisionModelValidator = (
  settings: StoredSettings,
  configuration: VisionModelConfiguration
) => VisionModelConfiguration | void

type SessionDetailsModelValidator = (
  settings: StoredSettings,
  configuration: SessionDetailsModelConfiguration
) => SessionDetailsModelConfiguration | void

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

const buildSessionDetailsModelMutation =
  (configuration: SessionDetailsModelConfiguration, validate?: SessionDetailsModelValidator) =>
  (settings: StoredSettings): StoredSettings => ({
    ...settings,
    sessionDetailsModel: structuredClone(validate?.(settings, configuration) ?? configuration)
  })

const buildVisionModelMutation =
  (configuration: VisionModelConfiguration | undefined, validate?: VisionModelValidator) =>
  (settings: StoredSettings): StoredSettings => {
    const next = { ...settings }
    if (!configuration) {
      delete next.visionModel
      return next
    }
    next.visionModel = structuredClone(validate?.(settings, configuration) ?? configuration)
    return next
  }

export {
  buildReviewerModelMutation,
  buildSessionDetailsModelMutation,
  buildSubagentModelMutation,
  buildVisionModelMutation
}
export type {
  ReviewerModelValidator,
  SessionDetailsModelValidator,
  SubagentModelValidator,
  VisionModelValidator
}
