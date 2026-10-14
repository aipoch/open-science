import type { ReplayIssue, ReplayResource, ReplayRunIndex } from '../../../../shared/replay'
import type { ReviewWithChecks } from '../../../../shared/reviewer'
import type { PersistedChatSession } from '../../../../shared/session-persistence'

export type ReplaySourceData = {
  session: PersistedChatSession
  runs: ReplayRunIndex[]
  reviews?: ReviewWithChecks[]
  resources: ReplayResource[]
  issues: ReplayIssue[]
}
