import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ResearchSubmission } from '../../../../shared/research-submission'
import type { ResearchWorkspaceRequest } from '../../../../shared/research-workspace'
import type {
  SendWorkspaceMessageIntent,
  SendWorkspaceMessageResult
} from '../acp/useWorkspaceAgentRuntime'
import { ensureRuntimeWriter, runtimeWriterSaveOptions } from '../acp/runtime-writer-client'
import { useSessionStore } from '../../stores/session-store'
import { ResearchSubmissionDispatcher } from './dispatcher'

type Options = {
  scope?: ResearchWorkspaceRequest
  ready: boolean
  send: (input: SendWorkspaceMessageIntent) => Promise<SendWorkspaceMessageResult | undefined>
  changed: (items: ResearchSubmission[]) => void
}
export const useResearchSubmissions = ({
  scope,
  ready,
  send,
  changed
}: Options): ResearchSubmission[] => {
  const latest = useRef({ ready, send, changed })
  useLayoutEffect(() => {
    latest.current = { ready, send, changed }
  }, [ready, send, changed])
  const [snapshot, setSnapshot] = useState<{ key: string; items: ResearchSubmission[] }>({
    key: '',
    items: []
  })
  const projectId = scope?.projectId
  const sourceSessionId = scope?.sourceSessionId
  const key = projectId && sourceSessionId ? JSON.stringify([projectId, sourceSessionId]) : ''
  // Mount in every workspace, even when the elected writer is currently looking at another
  // Project. A non-owner window can enqueue; it never needs to execute the model itself.
  useEffect(() => {
    if (!window.api?.researchSubmissions) return
    let disposed = false
    const dispatcher = new ResearchSubmissionDispatcher({
      writer: async () =>
        latest.current.ready && (await ensureRuntimeWriter())
          ? runtimeWriterSaveOptions()
          : undefined,
      claim: (request) => window.api.researchSubmissions.claim(request),
      finish: (request) => window.api.researchSubmissions.finish(request),
      hydrate: (session) => useSessionStore.getState().upsertPersistedSession(session),
      send: (input) => latest.current.send(input)
    })
    const tick = (): void => {
      if (!disposed) void dispatcher.tick().catch(() => undefined)
    }
    const interval = window.setInterval(tick, 1000)
    tick()
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [])
  useEffect(() => {
    if (!projectId || !sourceSessionId || !window.api?.researchSubmissions) return
    let disposed = false
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const items = await window.api.researchSubmissions.list({ projectId, sourceSessionId })
        if (!disposed) {
          setSnapshot({ key, items })
          latest.current.changed(items)
        }
      } catch {
        /* Retain the last journal view while transport recovers. */
      } finally {
        pending = false
      }
    }
    const timer = window.setInterval(() => void refresh(), 500)
    void refresh()
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [key, projectId, sourceSessionId])
  return snapshot.key === key ? snapshot.items : []
}
