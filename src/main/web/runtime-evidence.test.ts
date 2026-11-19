import { describe, expect, it, vi, type Mock } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { WebInvocationScope } from './invocation-store'
import type { WebService } from './service'
import { WebRuntimeEvidence } from './runtime-evidence'

const fixture = (): {
  session: PersistedChatSession
  scope: WebInvocationScope
  service: { fetch: Mock<WebService['fetch']>; commitSnapshot: Mock<WebService['commitSnapshot']> }
  ensureBranchOwnership: Mock<() => Promise<void>>
  runtime: WebRuntimeEvidence
} => {
  const graph = createLinearConversationGraph({
    sessionId: 'session',
    messages: [],
    frameworkId: 'open-science-agent',
    createdAt: 1,
    updatedAt: 1
  })
  const scope: WebInvocationScope = {
    projectId: 'project',
    sessionId: 'session',
    branchId: graph.branches[0].id,
    agentFrameId: graph.rootFrameId,
    promptMessageId: 'prompt',
    runtimeSegmentId: graph.runtimeSegments[0].id
  }
  const session: PersistedChatSession = {
    id: 'session',
    projectId: 'project',
    title: 'Research',
    cwd: '/workspace',
    status: 'idle',
    permissionProfile: 'auto',
    messages: [],
    conversationGraph: graph,
    createdAt: 1,
    updatedAt: 1
  }
  const service = {
    fetch: vi.fn<WebService['fetch']>().mockResolvedValue({
      schema: 'open-science.web.v1',
      invocation_id: 'invocation',
      operation: 'fetch',
      request: { url: 'https://example.org/' },
      status: 'error',
      retrieved_at: '2026-11-16T00:00:00.000Z',
      duration_ms: 0,
      warnings: [],
      sources: [],
      error: { code: 'NETWORK_ERROR', retryable: true }
    }),
    commitSnapshot: vi.fn<WebService['commitSnapshot']>().mockResolvedValue(undefined)
  }
  const ensureBranchOwnership = vi.fn(async () => undefined)
  const runtime = new WebRuntimeEvidence({
    service,
    loadSession: async () => session,
    ensureBranchOwnership
  })
  return { session, scope, service, ensureBranchOwnership, runtime }
}

describe('Web runtime evidence branch admission', () => {
  it('uses the recorded branch for evidence and the Session for shared admission', async () => {
    const { session, scope, service, runtime, ensureBranchOwnership } = fixture()
    const signal = new AbortController().signal
    const input = { url: 'https://example.org/' }
    await runtime.fetch(scope, input, { invocationId: 'invocation', signal })
    expect(ensureBranchOwnership).toHaveBeenCalledExactlyOnceWith(session, scope.branchId)
    expect(service.fetch).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(['project', 'session', scope.branchId]),
      input,
      { invocationId: 'invocation', signal, sessionSlotKey: JSON.stringify(['project', 'session']) }
    )
    const authorize = async (): Promise<boolean> => true
    await runtime.commit(scope, 'snapshot', authorize)
    expect(service.commitSnapshot).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(['project', 'session', scope.branchId]),
      'snapshot',
      authorize
    )
  })

  it.each(['projectId', 'sessionId', 'branchId', 'agentFrameId'] as const)(
    'rejects another %s before fetching or committing',
    async (field) => {
      const { scope, service, runtime, ensureBranchOwnership } = fixture()
      const stale = { ...scope, [field]: 'another' }
      await expect(runtime.fetch(stale, {}, {})).rejects.toThrow('another active Session branch')
      await expect(runtime.commit(stale, 'snapshot', async () => true)).rejects.toThrow(
        'another active Session branch'
      )
      expect(ensureBranchOwnership).not.toHaveBeenCalled()
      expect(service.fetch).not.toHaveBeenCalled()
      expect(service.commitSnapshot).not.toHaveBeenCalled()
    }
  )

  it('rejects a branch switch during legacy evidence adoption', async () => {
    const { scope, session, service, runtime, ensureBranchOwnership } = fixture()
    ensureBranchOwnership.mockImplementation(async () => {
      session.conversationGraph!.frames[0].activeBranchId = 'new-branch'
    })
    await expect(runtime.fetch(scope, {}, {})).rejects.toThrow('another active Session branch')
    expect(service.fetch).not.toHaveBeenCalled()
  })

  it('does not dispatch after cancellation while adopting evidence', async () => {
    const { scope, service, runtime, ensureBranchOwnership } = fixture()
    const controller = new AbortController()
    ensureBranchOwnership.mockImplementation(async () => {
      controller.abort()
    })
    await expect(runtime.fetch(scope, {}, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(service.fetch).not.toHaveBeenCalled()
  })
})
