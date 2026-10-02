import type { ReplaySourceIdentity } from '../../../../shared/replay'
export { estimateReplayBytes, indexReplayRun } from '../../../../shared/replay'

export const replaySourceKey = (
  source: Pick<ReplaySourceIdentity, 'projectId' | 'sessionId' | 'fingerprint'>
): string => JSON.stringify([source.projectId, source.sessionId, source.fingerprint])
