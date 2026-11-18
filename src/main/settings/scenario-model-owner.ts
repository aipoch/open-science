import { createReviewerModels, type ReviewerModelOwner } from './reviewer-model-owner'
import {
  createSessionDetailsModels,
  type SessionDetailsModelOwner
} from './session-details-model-owner'
import { createSubagentModels, type SubagentModelOwner } from './subagent-model-owner'
import { createVisionModels, type VisionModelOwner } from './vision-model-owner'
import { ImageModelOwner } from './image-model-owner'

class ScenarioModelOwner {
  constructor(
    readonly subagent: SubagentModelOwner,
    readonly reviewer: ReviewerModelOwner,
    readonly sessionDetails: SessionDetailsModelOwner,
    readonly vision: VisionModelOwner,
    readonly image: ImageModelOwner
  ) {}
}

const createScenarioModels = (
  ...args: Parameters<typeof createSubagentModels>
): ScenarioModelOwner =>
  new ScenarioModelOwner(
    createSubagentModels(...args),
    createReviewerModels(...args),
    createSessionDetailsModels(...args),
    createVisionModels(...args),
    new ImageModelOwner(args[0])
  )

export { createScenarioModels, ScenarioModelOwner }
