import type { AcpResumeSessionRequest } from '../../shared/acp'
import type { AcpRuntimeActivityPort } from './runtime-activity-port'

// A background workflow uses one concrete runtime generation for its whole lifetime. Session metadata
// is optional and consumed lazily only if that workflow later needs to prompt the main conversation.
export type AcpRuntimeActivityOptions = {
  session?: AcpResumeSessionRequest & {
    historyPreamble?: string
  }
}

export type AcpRuntimeActivity = Pick<
  AcpRuntimeActivityPort,
  'buildReviewerSession' | 'disposeReviewerSession' | 'sendPrompt' | 'sendApplicationPrompt'
> &
  Partial<Pick<AcpRuntimeActivityPort, 'captureBackend' | 'beginProviderTurnObservation'>>

export type AcpRuntimeActivityOwner = {
  withActivity: <T>(
    options: AcpRuntimeActivityOptions,
    work: (runtime: AcpRuntimeActivity) => Promise<T>
  ) => Promise<T>
}
