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

// Keep the heavy child components inert so the test exercises only WorkspacePage's own effects.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizableHandle: (): React.JSX.Element => <div data-testid="resize-handle" />
}))

vi.mock('@/lib/session-persistence/session-persistence', () => ({
  useSessionPersistence: () => true
}))

vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  useWorkspaceAgentRuntime: () => ({
    actionError: null,
    pendingPermissions: [],
    sendMessage: vi.fn(),
    cancelRun: vi.fn(),
    deleteRuntimeSession: vi.fn(),
    respondToPermission: vi.fn()
  })
}))

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: (): React.JSX.Element => <aside />
}))

vi.mock('./ConversationPanel', () => ({
  ConversationPanel: (): React.JSX.Element => <section data-testid="conversation" />
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

// Builds a minimal persisted-shape session that belongs to a given project.
const createSession = (id: string, projectId: string, cwd: string): ChatSession => {
  const now = Date.now()

  return {
    id,
    projectId,
    title: 'Session',
    cwd,
    status: 'idle',
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

describe('WorkspacePage notebook entry hydration', () => {
  let container: HTMLDivElement
  let root: Root
  let getReference: ReturnType<typeof vi.fn>

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSessionStore.setState(createInitialSessionState())
    useProjectStore.setState({ projects: [] })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: undefined })
    vi.clearAllMocks()
    getReference = vi.fn(() => Promise.resolve(null))
    window.api = {
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference
      },
      preview: {
        load: vi.fn(() => Promise.resolve(undefined)),
        save: vi.fn(() => Promise.resolve())
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

  it('probes the persisted notebook using the session project id, not the default project name', async () => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-1',
          name: 'Project One',
          description: '',
          isExample: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ]
    })
    useSessionStore.setState({
      sessions: [createSession('sess-1', 'proj-1', '/workspace/proj-1')],
      selectedSessionId: 'sess-1'
    })

    root = createRoot(container)
    await act(async () => {
      root.render(<WorkspacePage isSessionPersistenceReady={true} />)
    })

    expect(getReference).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      workspaceCwd: '/workspace/proj-1',
      projectName: 'proj-1'
    })
  })
})
