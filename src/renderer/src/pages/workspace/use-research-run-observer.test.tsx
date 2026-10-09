// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  NotebookRunRecord,
  NotebookSessionReference,
  NotebookSessionState
} from '../../../../shared/notebook'
import { useResearchRunStore } from '@/stores/research-run-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import { researchIdentity } from './research-draft-identity'
import {
  findResearchRun,
  matchesResearchRunRequest,
  useResearchRunObserver
} from './use-research-run-observer'

const open = vi.hoisted(() => vi.fn())
vi.mock('./replay/open-run-observation', () => ({ showRunObservation: open }))
const source = {
  sourceProjectId: 'project-1',
  sourceSessionId: 'source-1',
  sourceImportId: 'import-1',
  sourceTitle: 'Study'
}
const request = {
  requestId: 'request-1',
  source,
  requestedAt: 1,
  sessionId: 'session-1',
  promptMessageId: 'prompt-1',
  settled: true,
  autoOpenNavigationRevision: 1
}
const reference: NotebookSessionReference = {
  projectId: 'project-1',
  sessionId: 'session-1',
  workspaceCwd: '/work',
  notebookSessionRoot: '/notebook',
  runtimeRoot: '/runtime',
  dataRoot: '/data',
  runJsonPath: '/run.json'
}
const run = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  executionInvocationId: 'managed-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'bash',
  shellRuntime: { kind: 'native-posix', shell: '/bin/bash' },
  script: 'execute',
  status: 'running',
  startedAt: 1,
  promptMessageId: 'prompt-1',
  rootFrameId: 'root-1',
  agentFrameId: 'root-1',
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: [],
  ...overrides
})
const state = (runs: NotebookRunRecord[]): NotebookSessionState => ({
  id: 'notebook-1',
  sessionId: 'session-1',
  cwd: '/work',
  notebookSessionRoot: '/notebook',
  dataRoot: '/data',
  runtimeRoot: '/runtime',
  runJsonPath: '/run.json',
  kernelStatus: 'idle',
  cells: [],
  runCount: runs.length,
  latestRunEnvironments: {},
  runs,
  recentRuns: runs,
  environments: []
})
const session = (overrides: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Discussion',
    researchMembership: source,
    status: 'running',
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Run research',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }) as ChatSession
let listeners: Array<(event: NotebookSessionReference) => void>
let notebookState: ReturnType<typeof vi.fn>
let getReference: ReturnType<typeof vi.fn>

const setupRequest = (): void => {
  useResearchRunStore.setState({ requests: { [researchIdentity(source)]: request } })
}
const emit = async (event = reference): Promise<void> => {
  await act(async () => {
    for (const listener of listeners) listener(event)
  })
}

afterEach(() => cleanup())

describe('research launch observation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    listeners = []
    notebookState = vi.fn().mockResolvedValue(state([run()]))
    getReference = vi.fn().mockResolvedValue(reference)
    window.api = {
      notebook: {
        getReference,
        state: notebookState,
        onAvailable: vi.fn((listener) => {
          listeners.push(listener)
          return vi.fn()
        }),
        onChanged: vi.fn((listener) => {
          listeners.push(listener)
          return vi.fn()
        })
      }
    } as unknown as Window['api']
    useNavigationStore.setState({
      activeProjectId: 'project-1',
      view: 'workspace',
      explicitNavigationRevision: 1
    })
    useSessionStore.setState({
      sessions: [
        session({
          id: 'source-1',
          researchMembership: undefined,
          importedResearch: { importId: 'import-1' } as ChatSession['importedResearch']
        }),
        session()
      ],
      selectedSessionId: 'session-1'
    })
    usePackageOperationStore.setState({ operation: null })
    setupRequest()
  })
  it.each([
    { promptMessageId: 'unrelated-prompt' },
    { executionInvocationId: undefined },
    { executionInvocationId: 'ordinary-tool-call' },
    { agentFrameId: 'child' },
    { rootFrameId: undefined },
    { source: 'user' as const },
    { kernelKind: 'python' as const },
    { shellRuntime: undefined },
    { shellRuntime: { kind: 'powershell' as const, version: '7.6' as const } }
  ])('rejects a Run with missing or unrelated attribution: %j', (overrides) => {
    expect(matchesResearchRunRequest(run(overrides), request)).toBe(false)
  })
  it('selects the first exact managed Run and never switches a saved target to a later Run', () => {
    const first = run()
    const later = run({ runId: 'later', startedAt: 2 })
    expect(findResearchRun([later, first], request)).toBe(first)
    expect(
      findResearchRun([later], {
        ...request,
        target: {
          projectId: 'project-1',
          sessionId: 'session-1',
          runId: 'run-1',
          executionInvocationId: 'managed-1'
        }
      })
    ).toBeUndefined()
  })
  it('automatically opens the exact Run once, and offers explicit reopen after closure', async () => {
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe run' }))
    await waitFor(() => expect(result.current.request?.stage).toBe('running'))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        runId: 'run-1',
        executionInvocationId: 'managed-1'
      },
      'Observe run'
    )
    await emit()
    expect(open).toHaveBeenCalledTimes(1)
    act(() => {
      expect(result.current.open()).toBe(true)
    })
    expect(open).toHaveBeenCalledTimes(2)
  })
  it('does not initialize Notebook state while no reference exists, then follows exact availability', async () => {
    getReference.mockResolvedValue(null)
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe' }))
    await waitFor(() => expect(getReference).toHaveBeenCalled())
    expect(notebookState).not.toHaveBeenCalled()
    await emit({ ...reference, projectId: 'another-project' })
    expect(notebookState).not.toHaveBeenCalled()
    await emit()
    await waitFor(() => expect(result.current.request?.stage).toBe('running'))
  })
  it('never steals navigation, including a return after discovery while away', async () => {
    useNavigationStore.setState({ explicitNavigationRevision: 2 })
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe' }))
    await waitFor(() => expect(result.current.request?.stage).toBe('running'))
    expect(open).not.toHaveBeenCalled()
    act(() => useNavigationStore.setState({ explicitNavigationRevision: 1 }))
    expect(open).not.toHaveBeenCalled()
    act(() => {
      expect(result.current.open()).toBe(true)
    })
  })
  it('reconnects a persisted exact Run without automatically opening it', async () => {
    useResearchRunStore.setState({
      requests: {
        [researchIdentity(source)]: {
          ...request,
          autoOpenConsumed: true,
          autoOpenNavigationRevision: undefined,
          target: {
            projectId: 'project-1',
            sessionId: 'session-1',
            runId: 'run-1',
            executionInvocationId: 'managed-1'
          }
        }
      }
    })
    notebookState.mockResolvedValue(state([run({ status: 'completed' })]))
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe' }))
    await waitFor(() => expect(result.current.request?.stage).toBe('completed'))
    expect(open).not.toHaveBeenCalled()
    expect(notebookState).toHaveBeenCalledWith(expect.objectContaining({ runIds: ['run-1'] }))
  })
  it('distinguishes a completed agent turn without a managed Run from a successful experiment', async () => {
    notebookState.mockResolvedValue(state([run({ promptMessageId: 'other' })]))
    useSessionStore.setState((store) => ({
      sessions: store.sessions.map((s) =>
        s.id === 'session-1'
          ? {
              ...s,
              status: 'idle',
              messages: s.messages.map((m) => ({
                ...m,
                turnOutcome: { kind: 'completed', settledAt: 2 }
              }))
            }
          : s
      )
    }))
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe' }))
    await waitFor(() => expect(result.current.request?.stage).toBe('no-run'))
    expect(open).not.toHaveBeenCalled()
    expect(result.current.open()).toBe(false)
  })
  it('ignores a pending response after switching the source import identity', async () => {
    let finish!: (result: NotebookSessionState) => void
    notebookState.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { result, rerender } = renderHook(
      ({ selectedSource }) => useResearchRunObserver({ source: selectedSource, title: 'Observe' }),
      { initialProps: { selectedSource: source } }
    )
    await waitFor(() => expect(notebookState).toHaveBeenCalled())
    rerender({ selectedSource: { ...source, sourceImportId: 'another-import' } })
    await act(async () => finish(state([run()])))
    expect(result.current.request).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
  })
  it('remaps an optimistic destination and refuses another discussion membership', async () => {
    useResearchRunStore.setState({
      requests: {
        [researchIdentity(source)]: { ...request, sessionId: 'pending-1', settled: false }
      }
    })
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe' }))
    // A durable Session already contains the exact appended prompt: discover it while the
    // parent sendMessage promise is still waiting for the Agent turn to finish.
    await waitFor(() => expect(result.current.request?.stage).toBe('running'))
    act(() =>
      useSessionStore.setState((store) => ({
        sessions: store.sessions.map((s) =>
          s.id === 'session-1'
            ? { ...s, researchMembership: { ...source, sourceImportId: 'foreign' } }
            : s
        )
      }))
    )
    expect(result.current.open()).toBe(false)
    expect(result.current.request?.stage).toBe('unavailable')
  })
  it('recovers a no-run outcome from an exact unloaded destination after restart', async () => {
    const complete = session({
      status: 'idle',
      messages: session().messages.map((message) => ({
        ...message,
        turnOutcome: { kind: 'completed', settledAt: 2 }
      }))
    })
    const loadOne = vi.fn().mockResolvedValue(complete)
    window.api.sessions = { loadOne } as unknown as Window['api']['sessions']
    getReference.mockResolvedValue(null)
    useSessionStore.setState((store) => ({
      sessions: store.sessions.map((row) =>
        row.id === 'session-1' ? { ...row, contentLoaded: false, messages: [] } : row
      )
    }))
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe' }))
    await waitFor(() => expect(result.current.request?.stage).toBe('no-run'))
    expect(loadOne).toHaveBeenCalledWith({ projectId: 'project-1', sessionId: 'session-1' })
    expect(
      useSessionStore.getState().sessions.find((row) => row.id === 'session-1')?.contentLoaded
    ).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it('does not infer a restored request outcome from a missing or foreign prompt', async () => {
    window.api.sessions = {
      loadOne: vi.fn().mockResolvedValue(session({ messages: [], status: 'idle' }))
    } as unknown as Window['api']['sessions']
    getReference.mockResolvedValue(null)
    useSessionStore.setState((store) => ({
      sessions: store.sessions.map((row) =>
        row.id === 'session-1' ? { ...row, contentLoaded: false, messages: [] } : row
      )
    }))
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe' }))
    await waitFor(() => expect(result.current.request?.stage).toBe('unavailable'))
  })
  it('refuses ambiguous optimistic remapping before reading any Notebook', () => {
    useResearchRunStore.setState({
      requests: { [researchIdentity(source)]: { ...request, sessionId: 'pending', settled: false } }
    })
    useSessionStore.setState((store) => ({
      sessions: [...store.sessions, session({ id: 'session-2' })]
    }))
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe' }))
    expect(result.current.request?.sessionId).toBe('pending')
    expect(getReference).not.toHaveBeenCalled()
  })
  it('does not read Notebook state or open the viewer while the destination is export-locked', async () => {
    usePackageOperationStore.setState({
      operation: {
        id: 'export-1',
        kind: 'export',
        state: 'awaiting-selection',
        session: { projectId: 'project-1', sessionId: 'session-1' },
        progress: { phase: 'selecting' }
      }
    })
    const { result } = renderHook(() => useResearchRunObserver({ source, title: 'Observe' }))
    expect(notebookState).not.toHaveBeenCalled()
    expect(result.current.open()).toBe(false)
    act(() => usePackageOperationStore.setState({ operation: null }))
    await waitFor(() => expect(result.current.request?.stage).toBe('running'))
  })
})
