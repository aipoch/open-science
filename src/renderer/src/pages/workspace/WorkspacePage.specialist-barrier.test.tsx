// @vitest-environment jsdom
// Renderer-side tests for the specialist reconfigure barrier in WorkspacePage.
// Covers: fail-closed send gate (both holes), Retry re-invoking the barrier,
// double-send draft-restore prevention, and badge/chip display correctness.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'
import { useSpecialistStore } from '@/stores/specialist-store'

import { type ComposerDoc } from './composer/composer-doc'
import {
  markWorkspaceReviewHistoryLoaded,
  setDefaultWorkspaceAgentSettings
} from './workspace-page-test-fixtures'
import type { SpecialistListItem } from '../../../../shared/specialist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Capture all props WorkspacePage passes to ConversationPanel.
let conversationProps: Parameters<(typeof import('./ConversationPanel'))['ConversationPanel']>[0]
const panelSpecialistId = (): string | undefined =>
  conversationProps.view.activeSession?.specialistId ??
  conversationProps.specialist.view.specialist.newConversationId

const runtime = vi.hoisted(() => ({
  promptInFlightSessionIds: [] as string[],
  nativeContextCompactionSessionIds: [] as string[],
  sendMessage: vi.fn().mockResolvedValue({ sessionId: 'sess-a', messageId: 'msg-1' }),
  compactContext: vi.fn(),
  cancelRun: vi.fn(),
  deleteRuntimeSession: vi.fn(),
  respondToPermission: vi.fn()
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizableHandle: (): React.JSX.Element => <div data-testid="resize-handle" />
}))

vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  useWorkspaceAgentRuntime: () => ({
    actionError: null,
    pendingPermissions: [],
    promptInFlightSessionIds: runtime.promptInFlightSessionIds,
    nativeContextCompactionSessionIds: runtime.nativeContextCompactionSessionIds,
    sendMessage: runtime.sendMessage,
    compactContext: runtime.compactContext,
    cancelRun: runtime.cancelRun,
    deleteRuntimeSession: runtime.deleteRuntimeSession,
    respondToPermission: runtime.respondToPermission
  })
}))

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: (): React.JSX.Element => <aside />
}))

vi.mock('./ConversationPanel', () => ({
  ConversationPanel: (props: typeof conversationProps): React.JSX.Element => {
    conversationProps = props
    return <section data-testid="conversation" />
  }
}))

vi.mock('./PreviewPanel', () => ({
  PreviewPanel: (): React.JSX.Element => <div data-testid="preview-panel" />
}))

vi.mock('./EditSessionDialog', () => ({
  EditSessionDialog: (): React.JSX.Element => <div />
}))

vi.mock('./DeleteSessionDialog', () => ({
  DeleteSessionDialog: (): React.JSX.Element => <div />
}))

const { WorkspacePage } = await import('./WorkspacePage')

const makeSpecialist = (
  id: string,
  name: string,
  enabled = true
): SpecialistListItem & { kind: 'custom' } => ({
  kind: 'custom',
  id,
  name,
  description: '',
  systemPrompt: 'You are...',
  enabled,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1
})

const createSession = (overrides: Partial<ChatSession> = {}): ChatSession => {
  const now = Date.now()
  return {
    id: 'sess-a',
    projectId: 'proj-1',
    title: 'sess-a',
    cwd: '/workspace/proj-1',
    status: 'idle',
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

let container: HTMLDivElement
let root: Root

const apiStub = (specialistOverrides?: Record<string, unknown>): typeof window.api =>
  ({
    acp: { getPlanProjection: vi.fn(() => Promise.resolve(null)) },
    notebook: {
      onAvailable: vi.fn(() => vi.fn()),
      getReference: vi.fn(() => Promise.resolve(null))
    },
    preview: {
      load: vi.fn(() => Promise.resolve(undefined)),
      save: vi.fn(() => Promise.resolve())
    },
    uploads: { deleteUpload: vi.fn() },
    reviewer: {
      onUpdated: vi.fn(() => vi.fn()),
      onSuppressNextAutoReview: vi.fn(() => vi.fn()),
      onFixLoopStart: vi.fn(() => vi.fn()),
      onFixLoopEnd: vi.fn(() => vi.fn()),
      abortFixLoop: vi.fn(() => Promise.resolve())
    },
    compute: { enabledHostsSet: vi.fn(() => Promise.resolve()) },
    specialist: {
      onCatalogChanged: vi.fn(() => vi.fn()),
      setSessionSpecialist: vi.fn(() =>
        Promise.resolve({ status: 'applied' as const, contextReset: false })
      ),
      ...specialistOverrides
    }
  }) as never

const renderPage = async (r: Root): Promise<void> => {
  await act(async () => {
    r.render(
      <WorkspacePage
        isSessionPersistenceHydrated={true}
        isSessionPersistenceReady={true}
        canDeleteConversations={true}
      />
    )
  })
}

const setupBase = (): void => {
  setDefaultWorkspaceAgentSettings()
  markWorkspaceReviewHistoryLoaded({ projectId: 'proj-1', sessionId: 'sess-a' })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  useProjectStore.setState({ projects: [] })
  useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
  vi.clearAllMocks()
  runtime.promptInFlightSessionIds = []
  runtime.nativeContextCompactionSessionIds = []
  runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'msg-1' })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// Finding 2 — fail-closed send gate
// ---------------------------------------------------------------------------

describe('WorkspacePage fail-closed send gate', () => {
  it('blocks send when the bound specialist is missing from a loaded catalog', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-missing' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({ items: [], isLoaded: true, load: vi.fn() })
    window.api = apiStub()

    await renderPage(root)
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('hello')
      )
    })

    // Catalog is loaded and the bound specialist is not in it — sendMessage must NOT be called.
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('allows send when the bound specialist is present and enabled', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Debugger')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub()

    await renderPage(root)
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('hello')
      )
    })

    expect(conversationProps.conversation.availability.submit).toBe(true)
  })

  it('blocks send and triggers load when the catalog has not yet loaded (hole B)', async () => {
    setupBase()
    const loadMock = vi.fn()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a' })],
      selectedSessionId: 'sess-a'
    })
    // isLoaded=false simulates a fresh workspace where the submenu was never opened.
    useSpecialistStore.setState({
      items: [],
      isLoaded: false,
      load: loadMock
    })
    window.api = apiStub()

    await renderPage(root)
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('hello')
      )
    })

    // canSendMessage is based on rendered state; the gate fires inside sendCurrentMessage.
    // We call onSendMessage to exercise the path and verify load is triggered.
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(loadMock).toHaveBeenCalled()
  })

  it('allows send when there is a pending switch even though the effective specialist is unavailable (hole A)', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-missing', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-b', 'Researcher')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub()

    await renderPage(root)

    // Pick a new specialist while running — sets the pending state.
    await act(async () => {
      ;(conversationProps.specialist.actions.selectSpecialist as (id: string | undefined) => void)(
        'spec-b'
      )
    })

    // Session finishes its run → idle. User types and sends.
    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('hello')
      )
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    // The barrier should have been invoked with the new specialist.
    expect(window.api.specialist.setSessionSpecialist).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      specialistId: 'spec-b'
    })
  })

  it('keeps replay pending while an idle Specialist switch rebuilds provider context', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        createSession({
          specialistId: 'spec-a',
          pendingHistoryReplay: { kind: 'all' }
        })
      ],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Analyst'), makeSpecialist('spec-b', 'Researcher')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub({
      setSessionSpecialist: vi.fn(() =>
        Promise.resolve({ status: 'applied' as const, contextReset: true })
      )
    })

    await renderPage(root)
    expect(conversationProps.agentControls.canChangeSpecialist).toBe(true)

    await act(async () => {
      conversationProps.specialist.actions.selectSpecialist('spec-b')
      await Promise.resolve()
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      specialistId: 'spec-b',
      pendingHistoryReplay: { kind: 'all' },
      specialistSwitchResetRequired: true
    })
  })

  it('locks provider controls while an idle Specialist switch is in flight', async () => {
    setupBase()
    const switchRequest = Promise.withResolvers<{
      status: 'applied'
      contextReset: boolean
    }>()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Analyst'), makeSpecialist('spec-b', 'Researcher')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub({
      setSessionSpecialist: vi.fn(() => switchRequest.promise)
    })
    await renderPage(root)

    act(() => conversationProps.specialist.actions.selectSpecialist('spec-b'))

    expect(conversationProps.agentControls.canChange).toBe(false)
    expect(conversationProps.agentControls.canChangeMemory).toBe(false)
    expect(conversationProps.agentControls.canChangeSpecialist).toBe(false)
    expect(conversationProps.agentControls.canChangeAutoReview).toBe(true)

    await act(async () => {
      switchRequest.resolve({ status: 'applied', contextReset: false })
      await switchRequest.promise
    })
  })

  it('applies a pending switch to Main Agent before sending', async () => {
    setupBase()
    const setSessionSpecialist = vi.fn(() =>
      Promise.resolve({ status: 'applied' as const, contextReset: false })
    )
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Debugger')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)

    await act(async () => {
      ;(conversationProps.specialist.actions.selectSpecialist as (id: string | undefined) => void)(
        undefined
      )
    })
    expect(conversationProps.specialist.view.specialist.hasPendingSwitch).toBe(true)

    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('continue')
      )
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    expect(setSessionSpecialist).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      specialistId: undefined
    })
    expect(useSessionStore.getState().sessions[0].specialistId).toBeUndefined()
    expect(runtime.sendMessage).toHaveBeenCalledOnce()
  })

  it('uses an existing pending specialist for a branched child without reconfiguring the source', async () => {
    setupBase()
    const setSessionSpecialist = vi.fn(() =>
      Promise.resolve({ status: 'applied' as const, contextReset: false })
    )
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Debugger'), makeSpecialist('spec-b', 'Researcher')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)
    await act(async () => {
      ;(conversationProps.specialist.actions.selectSpecialist as (id: string | undefined) => void)(
        'spec-b'
      )
    })
    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('branch this work')
      )
    })
    expect(conversationProps.conversation.availability.submit).toBe(true)
    expect(conversationProps.conversation.actions.submit.draft).toBeTypeOf('function')
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [], mode: 'branch' })
    })

    expect(setSessionSpecialist).not.toHaveBeenCalled()
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        branchSourceSessionId: 'sess-a',
        sessionId: undefined,
        specialistId: 'spec-b'
      })
    )
    expect(useSessionStore.getState().sessions[0].specialistId).toBe('spec-a')
  })
})

// ---------------------------------------------------------------------------
// Finding 1 — Retry re-invokes the barrier
// ---------------------------------------------------------------------------

describe('WorkspacePage Retry recovery action', () => {
  it('re-runs the barrier on Retry and completes the send on success', async () => {
    setupBase()
    // First call: reject to show the banner. Second call: resolve to succeed.
    const setSessionSpecialist = vi
      .fn()
      .mockRejectedValueOnce(new Error('session reset failed'))
      .mockResolvedValueOnce({ status: 'applied' as const, contextReset: false })

    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-b', 'Researcher')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)

    // While the session is running, pick a new specialist — this sets the pending state.
    await act(async () => {
      ;(conversationProps.specialist.actions.selectSpecialist as (id: string | undefined) => void)(
        'spec-b'
      )
    })

    // Session finishes its run → idle. User types and sends.
    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('retry test')
      )
    })

    // First send: barrier fails → banner shown, send not dispatched.
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(conversationProps.specialist.view.specialist.reconfigureError).toBeTruthy()

    // Retry: barrier succeeds → send dispatched.
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({
        forcedSkillIds: [],
        mode: 'retry-reconfigure'
      })
    })

    expect(setSessionSpecialist).toHaveBeenCalledTimes(2)
    expect(runtime.sendMessage).toHaveBeenCalledOnce()
    expect(conversationProps.specialist.view.specialist.reconfigureError).toBeNull()
  })

  it('keeps the current binding while Use None is in flight', async () => {
    setupBase()
    let resolveUseNone!: (value: { status: 'applied'; contextReset: boolean }) => void
    const useNonePromise = new Promise<{ status: 'applied'; contextReset: boolean }>((resolve) => {
      resolveUseNone = resolve
    })
    const setSessionSpecialist = vi
      .fn()
      .mockRejectedValueOnce(new Error('session reset failed'))
      .mockReturnValueOnce(useNonePromise)

    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Debugger'), makeSpecialist('spec-b', 'Researcher')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)
    await act(async () => {
      ;(conversationProps.specialist.actions.selectSpecialist as (id: string | undefined) => void)(
        'spec-b'
      )
    })
    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('keep me')
      )
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    expect(conversationProps.specialist.view.specialist.reconfigureError).toBeTruthy()

    act(() => {
      ;(conversationProps.specialist.actions.useMainAgent as () => void)()
    })
    act(() => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
      ;(conversationProps.specialist.actions.useMainAgent as () => void)()
      ;(conversationProps.specialist.actions.selectSpecialist as (id: string | undefined) => void)(
        'spec-b'
      )
    })

    expect(setSessionSpecialist).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().sessions[0].specialistId).toBe('spec-a')
    expect(useSessionStore.getState().sessions[0].specialistBindingPending).toBeUndefined()
    expect(conversationProps.specialist.view.specialist.reconfigureError).toBeTruthy()
    expect(runtime.sendMessage).not.toHaveBeenCalled()

    await act(async () => {
      resolveUseNone({ status: 'applied', contextReset: false })
    })

    expect(setSessionSpecialist).toHaveBeenLastCalledWith({
      sessionId: 'sess-a',
      specialistId: undefined
    })
    expect(useSessionStore.getState().sessions[0].specialistId).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].specialistBindingPending).toBeUndefined()
    expect(conversationProps.specialist.view.specialist.reconfigureError).toBeNull()
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Finding 3 — double-send does not restore the just-sent draft
// ---------------------------------------------------------------------------

describe('WorkspacePage double-send race prevention', () => {
  it('blocks a second send while the barrier is in flight', async () => {
    setupBase()
    let resolveSwitch!: (v: { status: 'applied'; contextReset: boolean }) => void
    const switchPromise = new Promise<{ status: 'applied'; contextReset: boolean }>((res) => {
      resolveSwitch = res
    })
    const setSessionSpecialist = vi.fn(() => switchPromise)

    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-b', 'Researcher')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)

    // Set pending while running, then finish the run.
    await act(async () => {
      ;(conversationProps.specialist.actions.selectSpecialist as (id: string | undefined) => void)(
        'spec-b'
      )
    })
    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('first send')
      )
    })

    // Fire two sends before the barrier resolves.
    act(() => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })
    act(() => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    // Resolve the barrier and let the async work settle.
    await act(async () => {
      resolveSwitch({ status: 'applied', contextReset: false })
    })

    // Only one sendMessage call — the second was blocked by the in-flight guard.
    expect(runtime.sendMessage).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Finding 5 — badge shows the effective specialist, chip shows pending
// ---------------------------------------------------------------------------

describe('WorkspacePage specialist badge vs pending chip', () => {
  it('badge shows the effective specialist while a pending switch is in progress', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        createSession({
          specialistId: 'spec-a',
          status: 'running'
        })
      ],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Debugger'), makeSpecialist('spec-b', 'Researcher')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub()

    await renderPage(root)

    // Pick a different specialist while the session is running.
    await act(async () => {
      ;(conversationProps.specialist.actions.selectSpecialist as (id: string | undefined) => void)(
        'spec-b'
      )
    })

    // The badge (specialistId) shows the currently-effective specialist (spec-a).
    expect(panelSpecialistId()).toBe('spec-a')
    // The pending-switch chip should be shown.
    expect(conversationProps.specialist.view.specialist.hasPendingSwitch).toBe(true)
  })

  it('badge shows effective and chip is hidden when there is no pending switch', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Debugger')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub()

    await renderPage(root)

    expect(panelSpecialistId()).toBe('spec-a')
    expect(conversationProps.specialist.view.specialist.hasPendingSwitch).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// specialistUnavailable computation
// ---------------------------------------------------------------------------

describe('WorkspacePage specialistUnavailable computation', () => {
  it('marks unavailable when bound specialist is not in the loaded catalog', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-gone' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-other', 'Other')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub()

    await renderPage(root)

    expect(conversationProps.specialist.view.specialist.unavailable).toBe(true)
  })

  it('marks NOT unavailable when catalog is not yet loaded', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({ items: [], isLoaded: false, load: vi.fn() })
    window.api = apiStub()

    await renderPage(root)

    // While catalog is loading we cannot tell if the specialist is unavailable —
    // the guard should not show the unavailable state to avoid false positives.
    expect(conversationProps.specialist.view.specialist.unavailable).toBe(false)
  })

  it('does not mark unavailable when a pending switch overrides the effective specialist', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-gone', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-b', 'Researcher')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub()

    await renderPage(root)

    // While running, pick an available specialist — sets pending, overrides unavailability.
    await act(async () => {
      ;(conversationProps.specialist.actions.selectSpecialist as (id: string | undefined) => void)(
        'spec-b'
      )
    })

    // The unavailable badge should not show because there is a pending switch.
    expect(conversationProps.specialist.view.specialist.unavailable).toBe(false)
  })
})
