import type {
  ReviewWithChecks,
  ReviewRunRequest,
  ReviewRunResult,
  ReviewSessionRequest,
  ReviewSuppressionEvent,
  ReviewUpdateEvent
} from '../reviewer'

import { callable, type AcpListener, type RemoveListener, EVENT } from './definition'

export const contracts = {
  'reviewer.abortFixLoop': callable<(request: ReviewSessionRequest) => Promise<void>>()(
    'reviewer',
    ['reviewer:abort-fix-loop']
  ),
  'reviewer.getForSession': callable<
    (request: ReviewSessionRequest) => Promise<ReviewWithChecks[]>
  >()('reviewer', ['reviewer:get-for-session']),
  'reviewer.onFixLoopEnd': callable<
    (listener: AcpListener<ReviewSessionRequest>) => RemoveListener
  >()('reviewer', ['reviewer:fix-loop-end', EVENT]),
  'reviewer.onFixLoopStart': callable<
    (listener: AcpListener<ReviewSessionRequest>) => RemoveListener
  >()('reviewer', ['reviewer:fix-loop-start', EVENT]),
  'reviewer.onSuppressNextAutoReview': callable<
    (listener: AcpListener<ReviewSuppressionEvent>) => RemoveListener
  >()('reviewer', ['reviewer:suppress-next-auto-review', EVENT]),
  'reviewer.onUpdated': callable<(listener: AcpListener<ReviewUpdateEvent>) => RemoveListener>()(
    'reviewer',
    ['reviewer:updated', EVENT]
  ),
  'reviewer.run': callable<(request: ReviewRunRequest) => Promise<ReviewRunResult>>()('reviewer', [
    'reviewer:run'
  ])
} as const
