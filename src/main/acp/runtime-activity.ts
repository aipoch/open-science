import type { AcpResumeSessionRequest } from '../../shared/acp'
import type { AcpRuntime } from './runtime'

// A background workflow uses one concrete runtime generation for its whole lifetime. Session metadata
// is optional and consumed lazily only if that workflow later needs to prompt the main conversation.
export type AcpRuntimeActivityOptions = {
  session?: AcpResumeSessionRequest & {
    historyPreamble?: string
  }
}

export type AcpRuntimeActivity = Pick<
  AcpRuntime,
  'buildReviewerSession' | 'disposeReviewerSession' | 'sendPrompt'
>

export type AcpRuntimeActivityOwner = {
  withActivity: <T>(
    options: AcpRuntimeActivityOptions,
    work: (runtime: AcpRuntimeActivity) => Promise<T>
  ) => Promise<T>
}
