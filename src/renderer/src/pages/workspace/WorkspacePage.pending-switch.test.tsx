// @vitest-environment jsdom
// Renderer-side tests for the durable next-message switch closure (issue 08b).
// Covers: receiving the specialist:pending-switch broadcast from host.agents.switch(),
// mirroring the pending target WITHOUT switching the live agent mid-reply, applying the
// approved identity at the next sendMessage, restart survival via the durable binding,
// last-write-wins across multiple broadcasts, Main-Agent (null) clearing, and the pending
// chip being shown while the current reply completes under the old agent.
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
import { setDefaultWorkspaceAgentSettings } from './workspace-page-test-fixtures'
import type {
  CompletionHandoffLifecycleEvent,
  SpecialistListItem
} from '../../../../shared/specialist'

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

vi.mock('./RenameSessionDialog', () => ({
  RenameSessionDialog: (): React.JSX.Element => <div />
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

// Captured pending-switch listener; the test fires it to simulate the host.agents.switch() broadcast.
let pendingSwitchListener:
  ((pending: { sessionId: string; targetName: string | null }) => void) | undefined
let handoffLifecycleListener: ((event: CompletionHandoffLifecycleEvent) => void) | undefined

const apiStub = (specialistOverrides?: Record<string, unknown>): typeof window.api => {
  pendingSwitchListener = undefined
  handoffLifecycleListener = undefined
  return {
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
      onPendingSwitch: vi.fn((listener) => {
        pendingSwitchListener = listener
        return () => {
          pendingSwitchListener = undefined
        }
      }),
      getHandoffEvents: vi.fn(() => Promise.resolve([])),
      onHandoffLifecycleEvent: vi.fn((listener) => {
        handoffLifecycleListener = listener
        return () => {
          handoffLifecycleListener = undefined
        }
      }),
      retryHandoff: vi.fn(() => Promise.resolve()),
      cancelHandoff: vi.fn(() => Promise.resolve()),
      setSessionSpecialist: vi.fn(() =>
        Promise.resolve({ status: 'applied' as const, contextReset: false })
      ),
      resolveSessionSpecialist: vi.fn(() => Promise.resolve({ kind: 'main' as const })),
      ...specialistOverrides
    }
  } as never
}

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
// Broadcast mirrors pending target without switching the live agent
// ---------------------------------------------------------------------------

describe('WorkspacePage pending-switch broadcast', () => {
  it('does not duplicate an approved handoff failure in the composer recovery banner', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession()],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({ items: [], isLoaded: true, load: vi.fn() })
    window.api = apiStub()
    await renderPage(root)

    await act(async () => {
      handoffLifecycleListener?.({
        id: 'handoff-1',
        sessionId: 'sess-a',
        sequence: 4,
        observedAt: 1234,
        phase: 'failed',
        target: 'SQL Wrangler',
        provenance: {
          originatingTurnId: 'turn-1',
          attachmentIds: [],
          artifactIds: []
        },
        failure: { retryFrom: 'reconfiguring', message: 'target unavailable' }
      })
    })

    // The handoff transcript owns this error and its Retry action. The composer banner is reserved
    // for a user-initiated pre-send reconfiguration failure, otherwise one failure renders twice.
    expect(conversationProps.specialist.view.specialist.reconfigureError).toBeNull()
  })

  it('syncs the menu binding after a completed handoff, including a return to Main Agent', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a' })],
      selectedSessionId: 'sess-a'
    })
    const sqlWrangler = makeSpecialist('spec-b', 'SQL Wrangler')
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Data Analyst'), sqlWrangler],
      isLoaded: true,
      load: vi.fn()
    })
    const resolveSessionSpecialist = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'bound' as const, profile: sqlWrangler })
      .mockResolvedValueOnce({ kind: 'main' as const })
    window.api = apiStub({ resolveSessionSpecialist })
    await renderPage(root)

    await act(async () => {
      handoffLifecycleListener?.({
        id: 'handoff-specialist',
        sessionId: 'sess-a',
        sequence: 4,
        observedAt: 1234,
        phase: 'continuation-start',
        target: 'SQL Wrangler',
        provenance: { originatingTurnId: 'turn-1', attachmentIds: [], artifactIds: [] }
      })
      await Promise.resolve()
    })

    expect(resolveSessionSpecialist).toHaveBeenLastCalledWith({ sessionId: 'sess-a' })
    expect(useSessionStore.getState().sessions[0].specialistId).toBe('spec-b')
    expect(panelSpecialistId()).toBe('spec-b')

    await act(async () => {
      handoffLifecycleListener?.({
        id: 'handoff-main',
        sessionId: 'sess-a',
        sequence: 5,
        observedAt: 1235,
        phase: 'continuation-start',
        target: null,
        provenance: { originatingTurnId: 'turn-2', attachmentIds: [], artifactIds: [] }
      })
      await Promise.resolve()
    })

    expect(resolveSessionSpecialist).toHaveBeenLastCalledWith({ sessionId: 'sess-a' })
    expect(useSessionStore.getState().sessions[0].specialistId).toBeUndefined()
    expect(panelSpecialistId()).toBeUndefined()
  })

  it('does not create a composer recovery banner when replaying failed handoffs', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession()],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({ items: [], isLoaded: true, load: vi.fn() })
    const event = (
      id: string,
      sequence: number,
      commitOrder: number,
      message: string
    ): CompletionHandoffLifecycleEvent => ({
      id,
      sessionId: 'sess-a',
      sequence,
      commitOrder,
      observedAt: 100,
      phase: 'failed',
      target: 'SQL Wrangler',
      provenance: { originatingTurnId: 'turn-1', attachmentIds: [], artifactIds: [] },
      failure: { retryFrom: 'reconfiguring', message }
    })
    window.api = apiStub({
      getHandoffEvents: vi.fn(() =>
        Promise.resolve([
          event('older-high-sequence', 99, 1, 'older'),
          event('newer', 2, 2, 'newer')
        ])
      )
    })

    await renderPage(root)
    await act(async () => Promise.resolve())

    expect(conversationProps.specialist.view.specialist.reconfigureError).toBeNull()
  })

  it('mirrors the pending target WITHOUT calling setSessionSpecialist mid-reply', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      // The /customize reply is still running under the OLD specialist (spec-a).
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Data Analyst'), makeSpecialist('spec-b', 'SQL Wrangler')],
      isLoaded: true,
      load: vi.fn()
    })
    window.api = apiStub()

    await renderPage(root)

    // The broadcast arrives: host.agents.switch('SQL Wrangler') was approved on main.
    await act(async () => {
      pendingSwitchListener?.({ sessionId: 'sess-a', targetName: 'SQL Wrangler' })
    })

    // The pending-switch chip must show.
    expect(conversationProps.specialist.view.specialist.hasPendingSwitch).toBe(true)
    // The effective badge still shows the OLD specialist — the live agent was NOT switched.
    expect(panelSpecialistId()).toBe('spec-a')
    // Critically: the runtime switch must NOT have happened during the broadcast.
    expect(window.api.specialist.setSessionSpecialist).not.toHaveBeenCalled()
  })

  it('subscribes to the specialist:pending-switch channel once on mount', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession()],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({ items: [], isLoaded: true, load: vi.fn() })
    window.api = apiStub()

    await renderPage(root)

    expect(window.api.specialist.onPendingSwitch).toHaveBeenCalledTimes(1)
  })

  it('clears the binding (pending Main) when the broadcast targetName is null', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Data Analyst')],
      isLoaded: true,
      load: vi.fn()
    })
    const setSessionSpecialist = vi.fn(() =>
      Promise.resolve({ status: 'applied' as const, contextReset: false })
    )
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)

    // host.agents.switch(null) → revert to Main Agent.
    await act(async () => {
      pendingSwitchListener?.({ sessionId: 'sess-a', targetName: null })
    })

    expect(conversationProps.specialist.view.specialist.hasPendingSwitch).toBe(true)

    // Finish the run and send — the barrier must clear the binding via the same next-message path.
    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(textDoc('go'))
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

  it('applies the approved target at the next sendMessage via the reconfigure barrier', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Data Analyst'), makeSpecialist('spec-b', 'SQL Wrangler')],
      isLoaded: true,
      load: vi.fn()
    })
    const setSessionSpecialist = vi.fn(() =>
      Promise.resolve({ status: 'applied' as const, contextReset: false })
    )
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)

    await act(async () => {
      pendingSwitchListener?.({ sessionId: 'sess-a', targetName: 'SQL Wrangler' })
    })

    // The reply finishes; the next user message triggers the barrier.
    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('next turn')
      )
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    // The barrier reconfigured the live runtime under the NEW specialist (spec-b).
    expect(setSessionSpecialist).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      specialistId: 'spec-b'
    })
    expect(useSessionStore.getState().sessions[0].specialistId).toBe('spec-b')
    expect(runtime.sendMessage).toHaveBeenCalledOnce()
  })

  it('is last-write-wins when multiple broadcasts arrive before the next send', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [
        makeSpecialist('spec-a', 'Data Analyst'),
        makeSpecialist('spec-b', 'SQL Wrangler'),
        makeSpecialist('spec-c', 'Researcher')
      ],
      isLoaded: true,
      load: vi.fn()
    })
    const setSessionSpecialist = vi.fn(() =>
      Promise.resolve({ status: 'applied' as const, contextReset: false })
    )
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)

    // First approved switch, then a newer approved switch before the next send.
    await act(async () => {
      pendingSwitchListener?.({ sessionId: 'sess-a', targetName: 'SQL Wrangler' })
    })
    await act(async () => {
      pendingSwitchListener?.({ sessionId: 'sess-a', targetName: 'Researcher' })
    })

    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('final')
      )
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    // The newest target (Researcher → spec-c) wins.
    expect(setSessionSpecialist).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      specialistId: 'spec-c'
    })
    expect(useSessionStore.getState().sessions[0].specialistId).toBe('spec-c')
    expect(runtime.sendMessage).toHaveBeenCalledOnce()
  })

  it('preserves the composer draft when the reconfigure barrier fails', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Data Analyst'), makeSpecialist('spec-b', 'SQL Wrangler')],
      isLoaded: true,
      load: vi.fn()
    })
    const setSessionSpecialist = vi.fn().mockRejectedValueOnce(new Error('reconfigure failed'))
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)

    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('keep my draft')
      )
    })
    await act(async () => {
      pendingSwitchListener?.({ sessionId: 'sess-a', targetName: 'SQL Wrangler' })
    })

    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    // Reconfigure failed: never sent, draft preserved, recovery surface shown.
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(conversationProps.specialist.view.specialist.reconfigureError).toBeTruthy()
    // The draft content must survive the failure.
    expect((conversationProps.composer.view.doc as ComposerDoc).nodes[0]).toMatchObject({
      type: 'text',
      text: 'keep my draft'
    })
  })

  it('keeps the saved target pending when runtime application fails after persistence', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Data Analyst'), makeSpecialist('spec-b', 'SQL Wrangler')],
      isLoaded: true,
      load: vi.fn()
    })
    const setSessionSpecialist = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'pending' as const,
        reason: 'runtime-application-failed' as const
      })
      .mockResolvedValueOnce({ status: 'applied' as const, contextReset: false })
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)

    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(
        textDoc('keep pending draft')
      )
      pendingSwitchListener?.({ sessionId: 'sess-a', targetName: 'SQL Wrangler' })
      useSessionStore.getState().finishRun('sess-a')
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      specialistId: 'spec-b',
      specialistBindingPending: true
    })
    expect(conversationProps.specialist.view.specialist.reconfigureError).toMatchObject({
      committed: true
    })
    expect((conversationProps.composer.view.doc as ComposerDoc).nodes[0]).toMatchObject({
      type: 'text',
      text: 'keep pending draft'
    })

    await act(async () => {
      conversationProps.conversation.actions.submit.draft({
        forcedSkillIds: [],
        mode: 'retry-reconfigure'
      })
    })

    expect(setSessionSpecialist).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().sessions[0].specialistBindingPending).toBeUndefined()
    expect(runtime.sendMessage).toHaveBeenCalledOnce()
  })

  it('falls back to the durable binding when the target name is not in the loaded catalog', async () => {
    setupBase()
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    // Catalog loaded but does NOT contain the target name (e.g. name resolution must use the
    // durable binding that host.agents.switch already persisted on main).
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Data Analyst')],
      isLoaded: true,
      load: vi.fn()
    })
    const setSessionSpecialist = vi.fn(() =>
      Promise.resolve({ status: 'applied' as const, contextReset: false })
    )
    const resolveSessionSpecialist = vi.fn(() =>
      Promise.resolve({
        kind: 'bound' as const,
        profile: makeSpecialist('spec-b', 'SQL Wrangler')
      })
    )
    window.api = apiStub({ setSessionSpecialist, resolveSessionSpecialist })

    await renderPage(root)

    await act(async () => {
      pendingSwitchListener?.({ sessionId: 'sess-a', targetName: 'SQL Wrangler' })
    })
    // Let the async resolve settle.
    await act(async () => {
      await Promise.resolve()
    })

    // The renderer resolved the durable binding for the pending target.
    expect(resolveSessionSpecialist).toHaveBeenCalledWith({ sessionId: 'sess-a' })
    expect(conversationProps.specialist.view.specialist.hasPendingSwitch).toBe(true)
  })

  it('does not eagerly switch the live agent when a broadcast arrives while idle', async () => {
    setupBase()
    // The calling session already finished its reply (idle). Main already persisted the durable
    // binding; the broadcast only mirrors the pending target so the next send applies it.
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession({ specialistId: 'spec-a', status: 'idle' })],
      selectedSessionId: 'sess-a'
    })
    useSpecialistStore.setState({
      items: [makeSpecialist('spec-a', 'Data Analyst'), makeSpecialist('spec-b', 'SQL Wrangler')],
      isLoaded: true,
      load: vi.fn()
    })
    const setSessionSpecialist = vi.fn(() =>
      Promise.resolve({ status: 'applied' as const, contextReset: false })
    )
    window.api = apiStub({ setSessionSpecialist })

    await renderPage(root)

    await act(async () => {
      pendingSwitchListener?.({ sessionId: 'sess-a', targetName: 'SQL Wrangler' })
    })

    // The broadcast mirrors pending state only — the runtime must NOT switch eagerly.
    expect(setSessionSpecialist).not.toHaveBeenCalled()

    // The pending target still applies at the next send via the reconfigure barrier.
    await act(async () => {
      ;(conversationProps.composer.actions.changeDoc as (doc: ComposerDoc) => void)(textDoc('next'))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    expect(setSessionSpecialist).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      specialistId: 'spec-b'
    })
    expect(runtime.sendMessage).toHaveBeenCalledOnce()
  })
})
