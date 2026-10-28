import type {
  ResearchDemoSource,
  ResearchDemoReference,
  StartResearchDemoRequest,
  ResearchDemoInspection,
  ResearchDemoReceipt,
  ResearchDemoHistory,
  ResearchDemoQuestion,
  ResearchDemoQuestionRequest
} from '../research-demo'
import { callable, ELECTRON } from './definition'

export const contracts = {
  'researchDemos.readHistory': callable<
    (request: ResearchDemoSource) => Promise<ResearchDemoHistory>
  >()('research-demos', ['research-demos:read-history', ELECTRON]),
  'researchDemos.readReceipt': callable<
    (request: ResearchDemoReference) => Promise<ResearchDemoReceipt>
  >()('research-demos', ['research-demos:read-receipt', ELECTRON]),
  'researchDemos.question': callable<
    (request: ResearchDemoQuestionRequest) => Promise<ResearchDemoQuestion>
  >()('research-demos', ['research-demos:question', ELECTRON]),
  'researchDemos.inspect': callable<
    (request: ResearchDemoSource) => Promise<ResearchDemoInspection>
  >()('research-demos', ['research-demos:inspect', ELECTRON]),
  'researchDemos.start': callable<
    (request: StartResearchDemoRequest) => Promise<ResearchDemoReceipt>
  >()('research-demos', ['research-demos:start', ELECTRON]),
  'researchDemos.list': callable<(request: ResearchDemoSource) => Promise<ResearchDemoHistory>>()(
    'research-demos',
    ['research-demos:list', ELECTRON]
  ),
  'researchDemos.get': callable<(request: ResearchDemoReference) => Promise<ResearchDemoReceipt>>()(
    'research-demos',
    ['research-demos:get', ELECTRON]
  ),
  'researchDemos.stop': callable<
    (request: ResearchDemoReference) => Promise<ResearchDemoReceipt>
  >()('research-demos', ['research-demos:stop', ELECTRON]),
  'researchDemos.carriers': callable<
    (request: {
      projectId: string
    }) => Promise<Array<{ sessionId: string; source: ResearchDemoSource }>>
  >()('research-demos', ['research-demos:carriers', ELECTRON])
} as const
