import type { SessionDiscussionCapture } from './replay/replay-context'

export { createSessionReplayItem, showSessionReplay } from './session-replay-preview-item'

export const loadSessionDiscussionContext = async (
  projectId: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<SessionDiscussionCapture | undefined> => {
  const [{ loadReplayDocument }, { captureDiscussionSession }] = await Promise.all([
    import('@/lib/replay'),
    import('./replay/replay-context')
  ])
  const document = await loadReplayDocument(window.api, { projectId, sessionId }, { signal })
  return captureDiscussionSession(document)
}
