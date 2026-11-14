// @vitest-environment jsdom
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

import type { ComposerDoc } from './composer/composer-doc'

// Capture the props passed to the heavy child components so the test can observe the draft doc and
// the new-conversation Specialist binding.
let conversationProps: Parameters<(typeof import('./ConversationPanel'))['ConversationPanel']>[0]
const panelSpecialistId = (): string | undefined =>
  conversationProps.view.activeSession?.specialistId ??
  conversationProps.specialist.view.specialist.newConversationId

const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  cancelRun: vi.fn(),
  resumeInterruptedSession: vi.fn(),
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
    sessionCleanups: {},
    actionError: null,
    pendingPermissions: [],
    sendMessage: runtime.sendMessage,
    cancelRun: runtime.cancelRun,
    resumeInterruptedSession: runtime.resumeInterruptedSession,
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

const createSession = (id: string, projectId: string): ChatSession => {
  const now = Date.now()

  return {
    id,
    projectId,
    title: id,
    cwd: `/workspace/${projectId}`,
    status: 'idle',
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

// The exact unsent ComposerDoc the Settings `Chat with agent` entry must land in the composer.
const expectedCustomizeDoc: ComposerDoc = {
  nodes: [
    { type: 'skill', id: 'customize', name: 'Customize' },
    { type: 'text', text: '  Help me create a new specialist.' }
  ]
}
const expectedSkillCustomizeDoc: ComposerDoc = {
  nodes: [
    { type: 'skill', id: 'customize', name: 'Customize' },
    { type: 'text', text: '  Help me create a new skill.' }
  ]
}

describe('WorkspacePage customize prefill', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-1',
          name: 'Project',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    useNavigationStore.setState({
      view: 'workspace',
      activeProjectId: 'proj-1',
      userNavigationRevision: 0,
      explicitNavigationRevision: 0,
      pendingCustomizePrefill: undefined,
      pendingLiteratureReviewPrefill: undefined,
      pendingWslSupportPrefill: undefined
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession('sess-a', 'proj-1'), createSession('sess-b', 'proj-1')],
      selectedSessionId: undefined
    })
    vi.clearAllMocks()
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'm1' })
    window.api = {
      acp: { getPlanProjection: vi.fn(() => Promise.resolve(null)) },
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference: vi.fn(() => Promise.resolve(null))
      },
      preview: {
        load: vi.fn(() => Promise.resolve(undefined)),
        save: vi.fn(() => Promise.resolve())
      },
      uploads: {
        deleteUpload: vi.fn(() => Promise.resolve()),
        stageLocalFile: vi.fn(),
        claimLocalFile: vi.fn(() => Promise.resolve()),
        beginTransfer: vi.fn(),
        appendTransfer: vi.fn(),
        getTransferStatus: vi.fn(),
        finishTransfer: vi.fn(),
        abortTransfer: vi.fn(),
        onTransferProgress: vi.fn(() => vi.fn())
      },
      reviewer: {
        onUpdated: vi.fn(() => vi.fn()),
        onSuppressNextAutoReview: vi.fn(() => vi.fn()),
        onFixLoopStart: vi.fn(() => vi.fn()),
        onFixLoopEnd: vi.fn(() => vi.fn()),
        abortFixLoop: vi.fn(() => Promise.resolve())
      },
      compute: { enabledHostsSet: vi.fn(() => Promise.resolve()) }
    } as never
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    vi.restoreAllMocks()
    container.remove()
  })

  const renderPage = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })
  }

  it('prefills the new-conversation composer with the exact /customize doc on entry', async () => {
    useNavigationStore.setState({
      pendingCustomizePrefill: { projectId: 'proj-1', goal: 'specialist', requestId: 1 }
    })
    await renderPage()

    expect(conversationProps.composer.view.doc).toEqual(expectedCustomizeDoc)
  })

  it('prefills and consumes a normal WSL support conversation without sending it', async () => {
    const doc = { nodes: [{ type: 'text' as const, text: 'safe WSL diagnostics' }] }
    useNavigationStore.setState({
      pendingWslSupportPrefill: {
        projectId: 'proj-1',
        doc,
        setupSessionToken: 'setup-session-token',
        requestId: 1
      }
    })
    await renderPage()

    expect(conversationProps.composer.view.doc).toEqual(doc)
    expect(useNavigationStore.getState().pendingWslSupportPrefill).toBeUndefined()
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toHaveLength(2)
  })

  it('prefills the Skill chat entry with the Skill Creator goal', async () => {
    useNavigationStore.setState({
      pendingCustomizePrefill: { projectId: 'proj-1', goal: 'skill', requestId: 1 }
    })
    await renderPage()

    expect(conversationProps.composer.view.doc).toEqual(expectedSkillCustomizeDoc)
  })

  it('clears the pending prefill intent once it has been applied', async () => {
    useNavigationStore.setState({
      pendingCustomizePrefill: { projectId: 'proj-1', goal: 'specialist', requestId: 1 }
    })
    await renderPage()

    expect(useNavigationStore.getState().pendingCustomizePrefill).toBeUndefined()
  })

  it('does not auto-send or create a session on entry', async () => {
    useNavigationStore.setState({
      pendingCustomizePrefill: { projectId: 'proj-1', goal: 'specialist', requestId: 1 }
    })
    await renderPage()

    expect(runtime.sendMessage).not.toHaveBeenCalled()
    // No new session was created — the two pre-existing sessions remain and none is pending.
    expect(useSessionStore.getState().sessions).toHaveLength(2)
    expect(useSessionStore.getState().sessions.every((session) => !session.isPending)).toBe(true)
  })

  it('leaves the new-conversation draft with no Specialist binding', async () => {
    useNavigationStore.setState({
      pendingCustomizePrefill: { projectId: 'proj-1', goal: 'specialist', requestId: 1 }
    })
    await renderPage()

    // The fresh New Conversation draft carries no Specialist binding (no badge, no Customize Profile).
    expect(panelSpecialistId()).toBeUndefined()
  })

  it('starts empty when no prefill intent is pending', async () => {
    await renderPage()

    // No pending prefill: the new-conversation composer stays empty.
    expect(conversationProps.composer.view.doc).toEqual({ nodes: [] })
  })

  it('prefills an editable Literature review draft without sending it', async () => {
    useNavigationStore.setState({
      pendingLiteratureReviewPrefill: {
        projectId: 'proj-1',
        scope: {
          type: 'literature-scope',
          scope: 'collection',
          collectionId: 'collection-1',
          name: 'TP53 evidence'
        },
        prompt: 'Synthesize this literature into a concise review.',
        requestId: 1
      }
    })

    await renderPage()

    expect(conversationProps.composer.view.doc).toEqual({
      nodes: [
        {
          type: 'literature-scope',
          scope: 'collection',
          collectionId: 'collection-1',
          name: 'TP53 evidence'
        },
        { type: 'text', text: ' Synthesize this literature into a concise review.' }
      ]
    })
    expect(useNavigationStore.getState().pendingLiteratureReviewPrefill).toBeUndefined()
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('renders a selected session when an older preload omits plan projection hydration', async () => {
    useSessionStore.setState({ selectedSessionId: 'sess-a' })

    await expect(renderPage()).resolves.toBeUndefined()
    expect(container.querySelector('[data-testid="conversation"]')).not.toBeNull()
  })

  it.each(['project', 'collection'] as const)(
    'direct composer prepares an empty %s scope and focuses without sending',
    async (kind) => {
      const dispatch = vi.spyOn(window, 'dispatchEvent')
      await renderPage()
      const scope =
        kind === 'project'
          ? { type: 'literature-scope' as const, scope: 'project' as const }
          : {
              type: 'literature-scope' as const,
              scope: 'collection' as const,
              collectionId: 'collection-1',
              name: 'Evidence'
            }
      await act(async () => {
        useNavigationStore.getState().startLiteratureReviewConversation('proj-1', scope)
      })
      expect(conversationProps.composer.view.doc).toEqual({ nodes: [scope] })
      expect(useNavigationStore.getState().pendingLiteratureReviewPrefill).toBeUndefined()
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'open-science:focus-composer' })
      )
      expect(container.querySelector('[role="alertdialog"]')).toBeNull()
      expect(runtime.sendMessage).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, 'Synthesize this literature into a concise review.'])(
    'direct composer preserves every existing node, ignores a default prompt, and deduplicates repeat requests: %s',
    async (prompt) => {
      await renderPage()
      const original: ComposerDoc = {
        nodes: [
          { type: 'text', text: 'My unsent question ' },
          { type: 'skill', id: 'skill-a', name: 'Research' },
          { type: 'pasted-text', id: 'paste-a', text: 'Unsent source material' }
        ]
      }
      await act(async () => conversationProps.composer.actions.changeDoc(original))
      const scope = {
        type: 'literature-scope',
        scope: 'collection',
        collectionId: 'collection-1',
        name: 'Evidence'
      } as const
      await act(async () => {
        useNavigationStore.getState().startLiteratureReviewConversation('proj-1', scope, prompt)
      })
      const first = conversationProps.composer.view.doc
      expect(first.nodes.slice(0, original.nodes.length)).toEqual(original.nodes)
      expect(first.nodes.slice(original.nodes.length)).toEqual([{ type: 'text', text: ' ' }, scope])
      await act(async () => {
        useNavigationStore
          .getState()
          .startLiteratureReviewConversation(
            'proj-1',
            { ...scope, name: 'Renamed collection' },
            prompt
          )
      })
      expect(conversationProps.composer.view.doc).toEqual(first)
      expect(
        conversationProps.composer.view.doc.nodes.filter((node) => node.type === 'literature-scope')
      ).toHaveLength(1)
      expect(conversationProps.composer.view.doc.nodes).not.toContainEqual(
        expect.objectContaining({ text: ` ${prompt}` })
      )
      expect(useNavigationStore.getState().pendingLiteratureReviewPrefill).toBeUndefined()
      expect(container.querySelector('[role="alertdialog"]')).toBeNull()
      expect(runtime.sendMessage).not.toHaveBeenCalled()
    }
  )

  it('direct composer rejects overflow without trimming or retrying and permits a new explicit request', async () => {
    await renderPage()
    const original: ComposerDoc = {
      nodes: Array.from({ length: 10 }, (_, index) => ({
        type: 'artifact',
        id: `file-${index}`,
        name: `file-${index}.txt`,
        path: `/files/${index}.txt`,
        source: 'artifact'
      }))
    }
    await act(async () => conversationProps.composer.actions.changeDoc(original))
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    await act(async () => {
      useNavigationStore
        .getState()
        .startLiteratureReviewConversation('proj-1', { type: 'literature-scope', scope: 'project' })
    })
    expect(conversationProps.composer.view.doc).toEqual(original)
    expect(conversationProps.composer.view.error).toBe(
      'Could not add references. Check that the conversation is editable and the reference limit is not exceeded.'
    )
    expect(useNavigationStore.getState().pendingLiteratureReviewPrefill).toBeUndefined()
    const focusCount = dispatch.mock.calls.filter(
      ([event]) => event.type === 'open-science:focus-composer'
    ).length
    await act(async () => useNavigationStore.setState({ userNavigationRevision: 7 }))
    expect(
      dispatch.mock.calls.filter(([event]) => event.type === 'open-science:focus-composer')
    ).toHaveLength(focusCount)
    expect(conversationProps.composer.view.doc).toEqual(original)
    await act(async () =>
      conversationProps.composer.actions.changeDoc({ nodes: original.nodes.slice(0, 9) })
    )
    await act(async () => {
      useNavigationStore
        .getState()
        .startLiteratureReviewConversation('proj-1', { type: 'literature-scope', scope: 'project' })
    })
    expect(
      conversationProps.composer.view.doc.nodes.filter((node) => node.type === 'artifact')
    ).toHaveLength(9)
    expect(conversationProps.composer.view.doc.nodes.at(-1)).toEqual({
      type: 'literature-scope',
      scope: 'project'
    })
    expect(conversationProps.composer.view.error).toBeNull()
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('direct composer waits for the destination project new draft without writing to other projects or selected sessions', async () => {
    useProjectStore.setState((state) => ({
      projects: [
        ...state.projects,
        {
          id: 'proj-2',
          name: 'Other project',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }))
    useSessionStore.setState((state) => ({
      sessions: [...state.sessions, createSession('sess-c', 'proj-2')]
    }))
    await renderPage()
    const source: ComposerDoc = { nodes: [{ type: 'text', text: 'Original project draft' }] }
    await act(async () => conversationProps.composer.actions.changeDoc(source))
    await act(async () =>
      useNavigationStore.setState({
        pendingLiteratureReviewPrefill: {
          projectId: 'proj-2',
          scope: { type: 'literature-scope', scope: 'project' },
          requestId: 1
        }
      })
    )
    expect(conversationProps.composer.view.doc).toEqual(source)
    expect(useNavigationStore.getState().pendingLiteratureReviewPrefill).toBeDefined()
    await act(async () => {
      useSessionStore.setState({ selectedSessionId: 'sess-c' })
      useNavigationStore.setState({ activeProjectId: 'proj-2' })
    })
    expect(conversationProps.composer.view.doc).toEqual({ nodes: [] })
    expect(useNavigationStore.getState().pendingLiteratureReviewPrefill).toBeDefined()
    await act(async () => useSessionStore.setState({ selectedSessionId: undefined }))
    expect(conversationProps.composer.view.doc).toEqual({
      nodes: [{ type: 'literature-scope', scope: 'project' }]
    })
    expect(useNavigationStore.getState().pendingLiteratureReviewPrefill).toBeUndefined()
    await act(async () => useNavigationStore.setState({ activeProjectId: 'proj-1' }))
    expect(conversationProps.composer.view.doc).toEqual(source)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('uses the normal picked-Skill mechanism: the chip is a real skill node, not parsed text', async () => {
    useNavigationStore.setState({
      pendingCustomizePrefill: { projectId: 'proj-1', goal: 'specialist', requestId: 1 }
    })
    await renderPage()

    expect(conversationProps.composer.view.doc.nodes[0]).toEqual({
      type: 'skill',
      id: 'customize',
      name: 'Customize'
    })
    // The text node carries the two-space gap verbatim.
    expect(conversationProps.composer.view.doc.nodes[1]).toEqual({
      type: 'text',
      text: '  Help me create a new specialist.'
    })
  })

  it('discards an active history scratch when the explicit customize prefill arrives', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session, index) => ({
        ...session,
        messages: [
          {
            id: `prompt-${index}`,
            role: 'user',
            content: `starter ${index}`,
            status: 'complete',
            eventIds: [],
            createdAt: index,
            updatedAt: index
          }
        ]
      }))
    }))
    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.changeDoc({
        nodes: [{ type: 'text', text: 'old scratch' }]
      })
    })
    await act(async () => {
      conversationProps.composer.actions.navigateHistory('previous')
    })
    expect(conversationProps.composer.view.isHistoryBrowsing).toBe(true)

    await act(async () => {
      useNavigationStore.getState().startCustomizeConversation('proj-1')
    })
    expect(conversationProps.composer.view.doc).toEqual(expectedCustomizeDoc)
    expect(conversationProps.composer.view.isHistoryBrowsing).toBe(false)
    expect(conversationProps.composer.actions.navigateHistory('next')).toBe(false)
    expect(conversationProps.composer.view.doc).toEqual(expectedCustomizeDoc)
  })

  // F1 regression: `Chat with agent` prefill must survive when it is triggered from a workspace
  // where a real session IS already selected. The draft-key effect (which swaps drafts on selection
  // change) used to run after the render-phase prefill write and clobber it with the stored/empty
  // New Conversation draft. Here we mount with sess-a selected, then fire the prefill intent.
  it('preserves the /customize prefill when opened from an already-selected session', async () => {
    // Mount with a real session selected so the draft-key effect has a non-New key to switch from.
    useSessionStore.setState({ selectedSessionId: 'sess-a' })
    await renderPage()
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-a')

    // Trigger the `Chat with agent` intent the same way the SpecialistsPanel does.
    await act(async () => {
      useNavigationStore.getState().startCustomizeConversation('proj-1')
    })

    // (1) The composer draft must be exactly the customize prefill — not empty, not the prior
    // session's draft.
    expect(conversationProps.composer.view.doc).toEqual(expectedCustomizeDoc)

    // (2) No staged attachments or transfers may leak from the previously-selected session.
    expect(conversationProps.composer.view.attachments).toEqual([])
    expect(conversationProps.composer.view.transfers).toEqual([])
    // (3) No Specialist binding on the fresh New Conversation draft.
    expect(panelSpecialistId()).toBeUndefined()

    // (4) Still no auto-send / no session creation on this path either.
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toHaveLength(2)
  })

  it('preserves an existing draft once the prefill has been consumed on first mount', async () => {
    useNavigationStore.setState({
      pendingCustomizePrefill: { projectId: 'proj-1', goal: 'specialist', requestId: 1 }
    })
    await renderPage()
    expect(conversationProps.composer.view.doc).toEqual(expectedCustomizeDoc)

    // The intent is gone; a re-render does not re-apply or clobber an edited draft.
    const edited: ComposerDoc = { nodes: [{ type: 'text', text: 'my edit' }] }
    await act(async () => {
      conversationProps.composer.actions.changeDoc(edited)
    })
    expect(conversationProps.composer.view.doc).toEqual(edited)
    expect(useNavigationStore.getState().pendingCustomizePrefill).toBeUndefined()
  })
})
