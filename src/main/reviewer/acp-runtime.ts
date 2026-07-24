import type { AcpRuntime } from '../acp/runtime'
import type {
  AcpRuntimeActivity,
  AcpRuntimeActivityOptions,
  AcpRuntimeActivityOwner
} from '../acp/runtime-activity'

// Reviewer orchestration needs only this public runtime surface. Keeping it structural lets tests use
// small stubs while production pins the whole review/fix-loop workflow to one runtime generation.
export type ReviewerAcpRuntime = Pick<
  AcpRuntime,
  'buildReviewerSession' | 'disposeReviewerSession' | 'sendPrompt'
> &
  Partial<AcpRuntimeActivityOwner>

export const withReviewerRuntimeActivity = <T>(
  runtime: ReviewerAcpRuntime,
  options: AcpRuntimeActivityOptions,
  work: (runtime: AcpRuntimeActivity) => Promise<T>
): Promise<T> => (runtime.withActivity ? runtime.withActivity(options, work) : work(runtime))
