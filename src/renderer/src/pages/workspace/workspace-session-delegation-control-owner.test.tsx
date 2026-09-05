// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DelegatedWorkRecord,
  PersistedChatSession
} from '../../../../shared/session-persistence'
import { SessionSizeLimitError } from '../../../../shared/session-persistence'
import type { AgentFrameworkView } from '../../../../shared/settings'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'

import {
  hasLiveDelegatedAttempts,
  useWorkspaceSessionDelegationControlOwner
} from './workspace-session-delegation-control-owner'

const frameworks: AgentFrameworkView[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    supportsSkills: true,
    supportsDelegatedWork: true
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    supportsSkills: true,
    supportsDelegatedWork: false
  },
  { id: 'codex', displayName: 'Codex', supportsSkills: true }
]

const deferred = <Value,>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: unknown) => void
} => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const persistedSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  revision: 1,
  title: 'Delegation control',
  cwd: '/workspace',
  status: 'idle',
  agentFrameworkId: 'claude-code',
  delegationPolicy: 'allow',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('Workspace Session Delegation control owner', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    useSessionStore.getState().hydrateSessions([persistedSession()])
  })

  afterEach(() => vi.unstubAllGlobals())

  it('waits for authority, deduplicates a pending policy, and preserves the value on failure', async () => {
    const deny = deferred<PersistedChatSession>()
    const setDelegationPolicy = vi
      .fn()
      .mockImplementationOnce(() => deny.promise)
      .mockRejectedValueOnce(new Error('Policy update failed'))
    vi.stubGlobal('window', { api: { sessions: { setDelegationPolicy } } })
    const setError = vi.fn()
    const { result } = renderHook(() => {
      const activeSession = useSessionStore((state) => state.sessions[0])
      return useWorkspaceSessionDelegationControlOwner({
        activeSession,
        selectedSessionId: activeSession?.id,
        selectedFrameworkId: 'opencode',
        frameworks,
        setError
      })
    })

    act(() => {
      void result.current.change(false)
      void result.current.change(false)
    })

    expect(setDelegationPolicy).toHaveBeenCalledOnce()
    expect(setDelegationPolicy).toHaveBeenCalledWith('project-1', 'session-1', 'deny')
    expect(result.current).toMatchObject({ enabled: true, pending: true })

    await act(async () => {
      deny.resolve(persistedSession({ revision: 2, delegationPolicy: 'deny', updatedAt: 2 }))
      await deny.promise
    })

    expect(result.current).toMatchObject({ enabled: false, pending: false })
    expect(setError).toHaveBeenLastCalledWith(null)

    await act(async () => {
      await result.current.change(true)
    })

    expect(result.current).toMatchObject({ enabled: false, pending: false })
    expect(setError).toHaveBeenLastCalledWith('Policy update failed')
  })

  it('reports policy size failures through the Session recovery owner', async () => {
    vi.stubGlobal('window', {
      api: {
        sessions: {
          setDelegationPolicy: vi.fn().mockRejectedValue(new SessionSizeLimitError())
        }
      }
    })
    const onSessionSizeLimit = vi.fn()
    const { result } = renderHook(() => {
      const activeSession = useSessionStore((state) => state.sessions[0])
      return useWorkspaceSessionDelegationControlOwner({
        activeSession,
        selectedSessionId: activeSession?.id,
        selectedFrameworkId: 'claude-code',
        frameworks,
        setError: vi.fn(),
        onSessionSizeLimit
      })
    })

    await act(() => result.current.change(false))

    expect(onSessionSizeLimit).toHaveBeenCalledWith('session-1')
  })

  it.each([
    ['supported', 'claude-code', true],
    ['explicitly unsupported', 'opencode', false],
    ['missing capability', 'codex', false],
    ['missing framework binding', undefined, false]
  ] as const)(
    'uses the existing Session framework when it is %s',
    async (_label, agentFrameworkId, expectedEditable) => {
      useSessionStore.setState(createInitialSessionState())
      useSessionStore
        .getState()
        .hydrateSessions([persistedSession({ agentFrameworkId, status: 'running' })])
      const setDelegationPolicy = vi.fn()
      vi.stubGlobal('window', { api: { sessions: { setDelegationPolicy } } })

      const { result } = renderHook(() => {
        const activeSession = useSessionStore((state) => state.sessions[0])
        return useWorkspaceSessionDelegationControlOwner({
          activeSession,
          selectedSessionId: activeSession?.id,
          selectedFrameworkId: 'claude-code',
          frameworks,
          setError: vi.fn()
        })
      })

      expect(result.current.frameworkSupported).toBe(expectedEditable)
      await act(() => result.current.change(false))
      expect(setDelegationPolicy).toHaveBeenCalledTimes(expectedEditable ? 1 : 0)
    }
  )

  it('prepares and resets a new Session draft from the selected global framework without IPC', async () => {
    const setDelegationPolicy = vi.fn()
    vi.stubGlobal('window', { api: { sessions: { setDelegationPolicy } } })
    const { result } = renderHook(() =>
      useWorkspaceSessionDelegationControlOwner({
        activeSession: undefined,
        selectedSessionId: undefined,
        selectedFrameworkId: 'claude-code',
        frameworks,
        setError: vi.fn()
      })
    )

    expect(result.current).toMatchObject({ frameworkSupported: true, enabled: true })
    await act(() => result.current.change(false))
    expect(result.current).toMatchObject({
      enabled: false,
      newConversationPolicyOverride: 'deny'
    })
    expect(setDelegationPolicy).not.toHaveBeenCalled()
    act(() => result.current.resetNewConversation())
    expect(result.current.enabled).toBe(true)
    expect(result.current.newConversationPolicyOverride).toBeUndefined()
  })

  it('resets the draft when a temporarily missing selected Session returns to a new conversation', async () => {
    const setDelegationPolicy = vi.fn()
    vi.stubGlobal('window', { api: { sessions: { setDelegationPolicy } } })
    const { result, rerender } = renderHook(
      ({ selectedSessionId }: { selectedSessionId: string | undefined }) =>
        useWorkspaceSessionDelegationControlOwner({
          activeSession: undefined,
          selectedSessionId,
          selectedFrameworkId: 'claude-code',
          frameworks,
          setError: vi.fn()
        }),
      { initialProps: { selectedSessionId: undefined as string | undefined } }
    )

    await act(() => result.current.change(false))
    expect(result.current.enabled).toBe(false)

    rerender({ selectedSessionId: 'temporarily-missing-session' })
    expect(result.current).toMatchObject({ enabled: true, sessionAuthoritative: false })

    rerender({ selectedSessionId: undefined })
    expect(result.current).toMatchObject({ enabled: true, sessionAuthoritative: true })
    expect(setDelegationPolicy).not.toHaveBeenCalled()
  })

  it('keeps a captured pending Session policy immutable without calling authority IPC', async () => {
    useSessionStore.setState(createInitialSessionState())
    const pending = useSessionStore.getState().appendPendingUserMessage({
      content: 'Start without delegation',
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      delegationPolicy: 'deny'
    })
    expect(pending).toBeDefined()
    const setDelegationPolicy = vi.fn()
    vi.stubGlobal('window', { api: { sessions: { setDelegationPolicy } } })

    const { result } = renderHook(() => {
      const activeSession = useSessionStore((state) => state.sessions[0])
      return useWorkspaceSessionDelegationControlOwner({
        activeSession,
        selectedSessionId: activeSession?.id,
        selectedFrameworkId: 'claude-code',
        frameworks,
        setError: vi.fn()
      })
    })

    expect(result.current).toMatchObject({
      enabled: false,
      sessionAuthoritative: false
    })
    await act(() => result.current.change(true))
    expect(result.current.enabled).toBe(false)
    expect(setDelegationPolicy).not.toHaveBeenCalled()
  })

  it('waits for bound Session authority before allowing a policy mutation', async () => {
    useSessionStore.setState(createInitialSessionState())
    const pending = useSessionStore.getState().appendPendingUserMessage({
      content: 'Start with delegation',
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      delegationPolicy: 'allow'
    })
    if (!pending) throw new Error('Expected a pending Session.')
    const setDelegationPolicy = vi.fn(async () =>
      persistedSession({
        id: 'bound-session',
        revision: 2,
        delegationPolicy: 'deny',
        updatedAt: 2
      })
    )
    vi.stubGlobal('window', { api: { sessions: { setDelegationPolicy } } })

    const { result } = renderHook(() => {
      const activeSession = useSessionStore((state) => state.sessions[0])
      return useWorkspaceSessionDelegationControlOwner({
        activeSession,
        selectedSessionId: activeSession?.id,
        selectedFrameworkId: 'claude-code',
        frameworks,
        setError: vi.fn()
      })
    })

    act(() => {
      useSessionStore.getState().bindPendingSession({
        pendingSessionId: pending.sessionId,
        sessionId: 'bound-session',
        agentFrameworkId: 'claude-code'
      })
    })
    expect(result.current.sessionAuthoritative).toBe(false)
    await act(() => result.current.change(false))
    expect(setDelegationPolicy).not.toHaveBeenCalled()

    act(() => {
      const source = useSessionStore.getState().sessions[0]
      useSessionStore.getState().applyDelegationPolicyAuthority({
        ...persistedSession({ id: 'bound-session' }),
        messages: source.messages
      })
    })
    expect(result.current.sessionAuthoritative).toBe(true)
    await act(() => result.current.change(false))
    expect(setDelegationPolicy).toHaveBeenCalledWith('project-1', 'bound-session', 'deny')
  })

  it('starts another new Session with the default allow policy', async () => {
    const setDelegationPolicy = vi.fn()
    vi.stubGlobal('window', { api: { sessions: { setDelegationPolicy } } })
    const existing = useSessionStore.getState().sessions[0]
    const { result, rerender } = renderHook(
      ({ activeSession }: { activeSession: typeof existing | undefined }) =>
        useWorkspaceSessionDelegationControlOwner({
          activeSession,
          selectedSessionId: activeSession?.id,
          selectedFrameworkId: 'claude-code',
          frameworks,
          setError: vi.fn()
        }),
      { initialProps: { activeSession: undefined as typeof existing | undefined } }
    )

    await act(() => result.current.change(false))
    expect(result.current.enabled).toBe(false)
    rerender({ activeSession: existing })
    rerender({ activeSession: undefined })
    expect(result.current.enabled).toBe(true)
    expect(setDelegationPolicy).not.toHaveBeenCalled()
  })

  it('finds running and awaiting-user attempts across all Message Branches', () => {
    const record = (
      frameId: string,
      attemptId: string,
      status: 'running' | 'completed'
    ): DelegatedWorkRecord => ({
      agentFrameId: frameId,
      attempts: [
        {
          id: attemptId,
          status,
          resolvedAgent: { kind: 'main' as const },
          runtimeSegmentIds: [],
          startedAt: 1
        }
      ]
    })
    const session = persistedSession({
      runtimeContext: {
        version: 1,
        revision: 0,
        delegatedWork: {
          records: [
            record('active-frame', 'done', 'completed'),
            record('other-frame', 'live', 'running')
          ],
          questionRequests: [
            {
              requestId: 'question-1',
              canonicalDigest: 'digest',
              sourceFrameId: 'other-frame',
              sourceAttemptId: 'live',
              sourceRuntimeSegmentId: 'segment',
              sourceMessageBranchId: 'inactive-branch',
              rootOriginMessageId: 'root',
              rootBranchId: 'branch',
              sourceName: 'Researcher',
              questions: [],
              askedAt: 1,
              status: 'pending',
              draftAnswers: [],
              draftQuestionIndex: 0
            }
          ]
        }
      }
    })

    expect(hasLiveDelegatedAttempts(session)).toBe(true)
    expect(
      hasLiveDelegatedAttempts({
        ...session,
        runtimeContext: {
          version: 1,
          revision: 0,
          delegatedWork: { records: [record('active-frame', 'done', 'completed')] }
        }
      })
    ).toBe(false)
  })
})
