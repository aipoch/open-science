import type {
  ResearchExecutionPreflight,
  ResearchExecutionConfigurationSnapshot,
  ResolveResearchExecutionConfiguration,
  ResearchExecutionPreflightRequest,
  ResearchExecutionProfileView,
  SaveResearchExecutionProfileRequest
} from '../research-execution-profile'
import { callable, ELECTRON } from './definition'

// Secrets can only be written through trusted local Electron. No HTTP or Host SDK writer.
export const contracts = {
  'researchExecutionProfiles.pending': callable<
    () => Promise<ResearchExecutionConfigurationSnapshot[]>
  >()('research-execution-profiles', ['research-execution-profiles:pending', ELECTRON]),
  'researchExecutionProfiles.resolve': callable<
    (
      request: ResolveResearchExecutionConfiguration
    ) => Promise<ResearchExecutionConfigurationSnapshot>
  >()('research-execution-profiles', ['research-execution-profiles:resolve', ELECTRON]),
  'researchExecutionProfiles.inspect': callable<
    (request: ResearchExecutionPreflightRequest) => Promise<ResearchExecutionPreflight>
  >()('research-execution-profiles', ['research-execution-profiles:inspect', ELECTRON]),
  'researchExecutionProfiles.save': callable<
    (request: SaveResearchExecutionProfileRequest) => Promise<ResearchExecutionProfileView>
  >()('research-execution-profiles', ['research-execution-profiles:save', ELECTRON]),
  'researchExecutionProfiles.remove': callable<
    (request: ResearchExecutionPreflightRequest) => Promise<void>
  >()('research-execution-profiles', ['research-execution-profiles:remove', ELECTRON])
} as const
