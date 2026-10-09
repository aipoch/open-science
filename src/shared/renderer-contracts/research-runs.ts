import type { InspectResearchRunRequest, ResearchRunInspection } from '../research-run-launcher'
import { callable, ELECTRON } from './definition'

export const contracts = {
  'researchRuns.inspect': callable<
    (request: InspectResearchRunRequest) => Promise<ResearchRunInspection>
  >()('research-runs', ['research-runs:inspect', ELECTRON])
} as const
