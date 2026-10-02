import type {
  PrepareManuscriptRequest,
  PrepareManuscriptResult,
  QuartoDetection,
  RenderManuscriptRequest,
  RenderManuscriptResult
} from '../manuscripts'

import { callable, LOCAL, RUNTIME_VALIDATED } from './definition'

export const contracts = {
  'manuscripts.detectQuarto': callable<() => Promise<QuartoDetection>>()('manuscripts', [
    'manuscripts:detect-quarto',
    LOCAL,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'manuscripts.prepare': callable<
    (request: PrepareManuscriptRequest) => Promise<PrepareManuscriptResult>
  >()('manuscripts', ['manuscripts:prepare', LOCAL, undefined, undefined, RUNTIME_VALIDATED]),
  'manuscripts.render': callable<
    (request: RenderManuscriptRequest) => Promise<RenderManuscriptResult>
  >()('manuscripts', ['manuscripts:render', LOCAL, undefined, undefined, RUNTIME_VALIDATED]),
  'manuscripts.export': callable<
    (request: RenderManuscriptRequest) => Promise<RenderManuscriptResult>
  >()('manuscripts', ['manuscripts:export', LOCAL, undefined, undefined, RUNTIME_VALIDATED])
} as const
