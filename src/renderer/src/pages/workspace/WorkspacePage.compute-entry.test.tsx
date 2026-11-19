// @vitest-environment jsdom
import { act } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { useNotebookMemoryNoticeStore } from '@/stores/notebook-memory-notice-store'
import type { NotebookMemoryRejectedEvent } from '../../../../shared/notebook-memory'
import { getByRole } from '@testing-library/dom'
import { installWebRendererContracts } from '../../../web/api-installer'
import { WEB_INVOKE_CHANNELS } from '../../../../shared/web-api-map.generated'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  PROJECT_COMPUTE_PREVIEW_ID,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'

// Keep unrelated panes inert; render the real WorkspacePage and WorkspaceSidebar.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizableHandle: (): React.JSX.Element => <div data-testid="resize-handle" />
}))

const memoryRuntime = vi.hoisted(() => ({ sendMessage: vi.fn() }))

vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  useWorkspaceAgentRuntime: () => ({
    sessionCleanups: {},
    actionError: null,
    pendingPermissions: [],
    sendMessage: memoryRuntime.sendMessage,
    cancelRun: vi.fn(),
    deleteRuntimeSession: vi.fn(),
    respondToPermission: vi.fn()
  })
}))

vi.mock('./ConversationPanel', () => ({
  ConversationPanel: (): React.JSX.Element => <section data-testid="conversation" />
}))

vi.mock('./PreviewPanel', () => ({
  PreviewPanel: (): React.JSX.Element => <div data-testid="preview-panel" />
}))

vi.mock('./SessionReproducibilityDialog', () => ({
  SessionReproducibilityDialog: ({ session }: { session?: { id: string } }) =>
    session ? <section aria-label="Reproducibility checks">{session.id}</section> : null
}))

vi.mock('./EditSessionDialog', () => ({
  EditSessionDialog: (): React.JSX.Element => <div />
}))

vi.mock('./DeleteSessionDialog', () => ({
  DeleteSessionDialog: (): React.JSX.Element => <div />
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { WorkspacePage } = await import('./WorkspacePage')

describe('WorkspacePage Compute entry with Web capabilities', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    memoryRuntime.sendMessage
      .mockReset()
      .mockResolvedValue({ sessionId: 'sess-1', messageId: 'new-prompt' })
    useNotebookMemoryNoticeStore.setState({
      rejection: undefined,
      warning: undefined,
      pressure: undefined,
      terminal: undefined,
      criticalScopes: [],
      dismissedRefusalIds: []
    })
    useSessionStore.setState(createInitialSessionState())
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [
        {
          id: 'proj-1',
          name: 'Project One',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
    useSessionStore.setState({
      sessions: [
        {
          id: 'sess-1',
          projectId: 'proj-1',
          title: 'Session',
          cwd: '/workspace/proj-1',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      selectedSessionId: 'sess-1'
    })
    window.api = {
      platform: 'linux',
      acp: {
        getPlanProjection: vi.fn().mockResolvedValue(null),
        continueNotebookExecution: vi.fn()
      },
      notebook: { getReference: vi.fn().mockResolvedValue(null) },
      preview: {
        load: vi.fn().mockResolvedValue(undefined),
        save: vi.fn(({ expectedRevision }) =>
          Promise.resolve({ status: 'saved' as const, revision: expectedRevision + 1 })
        )
      },
      compute: { enabledHostsSet: vi.fn().mockResolvedValue(undefined) }
    } as never
    // Let the production Web installer supply the reported API shape, including events.
    // No Electron-only namespace is manually supplied by this fixture.
    installWebRendererContracts(window.api, {
      availableRpcChannels: new Set([
        WEB_INVOKE_CHANNELS['notebook.getProjectActivity'],
        WEB_INVOKE_CHANNELS['notebook.getProjectResources'],
        WEB_INVOKE_CHANNELS['notebook.releaseSessionResources'],
        WEB_INVOKE_CHANNELS['notebook.retryResourceRelease'],
        WEB_INVOKE_CHANNELS['compute.jobsList']
      ]),
      restrictedRpcChannels: new Set(),
      invoke: vi.fn(async (channel) =>
        channel === WEB_INVOKE_CHANNELS['notebook.getProjectActivity']
          ? { kernels: [], backgroundRuns: [] }
          : []
      ),
      subscribe: vi.fn(() => vi.fn()),
      nativeAdapters: {}
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.restoreAllMocks()
    container.remove()
  })

  const renderPage = async (ready = true): Promise<HTMLButtonElement> => {
    await act(async () =>
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={ready}
          canDeleteConversations={true}
        />
      )
    )
    const navigation = getByRole(container, 'complementary', { name: 'Workspace navigation' })
    return getByRole(navigation, 'button', {
      name: 'Compute'
    }) as HTMLButtonElement
  }

  it.each(['agent', 'reproduction'])(
    'handles a live %s refusal with the Notebook pane closed',
    async (source) => {
      let reject!: (event: NotebookMemoryRejectedEvent) => void
      window.api.notebook.onMemoryRejected = (listener) => {
        reject = listener
        return () => undefined
      }
      await renderPage()
      await act(async () =>
        reject({
          projectId: 'proj-1',
          sessionId: 'sess-1',
          source,
          refusalId: 'live-refusal',
          workspaceCwd: '/workspace/proj-1',
          memory: {
            status: 'pressured',
            reason: 'linux-memory-low',
            source: 'linux-proc',
            executionScope: 'linux:host',
            checkedAt: 1
          }
        })
      )
      expect(screen.getByRole('dialog', { name: 'System memory is under pressure' })).toBeTruthy()
      expect(memoryRuntime.sendMessage).not.toHaveBeenCalled()
      await act(async () =>
        fireEvent.click(
          screen.getByRole('button', {
            name: source === 'reproduction' ? 'Open reproducibility checks' : 'Recheck and retry'
          })
        )
      )
      if (source === 'reproduction') {
        expect(screen.getByRole('region', { name: 'Reproducibility checks' }).textContent).toBe(
          'sess-1'
        )
        expect(memoryRuntime.sendMessage).not.toHaveBeenCalled()
      } else {
        expect(memoryRuntime.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'proj-1',
            sessionId: 'sess-1',
            requireExistingSession: true,
            notebookContinuation: { refusalId: 'live-refusal' },
            text: 'Recheck memory and reconsider the blocked Notebook work. Keep completed results and ask before repeating completed steps.'
          })
        )
      }
    }
  )

  it.each(['Web', 'Electron'])('opens project Compute with %s capabilities', async (surface) => {
    if (surface === 'Electron') {
      window.api.backgroundResultDelivery = { getProjectActivity: vi.fn() } as never
    }
    if (surface === 'Web') expect(window.api.backgroundResultDelivery).toBeUndefined()
    expect(typeof window.api.notebook.getProjectActivity).toBe('function')
    expect(typeof window.api.notebook.onChanged).toBe('function')
    expect(typeof window.api.compute.jobsList).toBe('function')
    expect(typeof window.api.compute.onJobUpdated).toBe('function')

    const compute = await renderPage()
    const navigation = getByRole(container, 'complementary', { name: 'Workspace navigation' })
    // The neighboring Files entry proves that persistence readiness is not blocking navigation.
    expect((getByRole(navigation, 'button', { name: 'Files' }) as HTMLButtonElement).disabled).toBe(
      false
    )
    expect(compute.disabled).toBe(false)
    await act(async () => compute.click())
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(PROJECT_COMPUTE_PREVIEW_ID)
  })

  it.each([
    ['notebook', 'getProjectActivity'],
    ['notebook', 'getProjectResources'],
    ['notebook', 'releaseSessionResources'],
    ['notebook', 'retryResourceRelease'],
    ['notebook', 'onChanged'],
    ['compute', 'jobsList'],
    ['compute', 'onJobUpdated']
  ] as const)('keeps Compute disabled without %s.%s', async (namespace, method) => {
    // An unrelated Electron capability cannot substitute for a dependency of this panel.
    window.api.backgroundResultDelivery = { getProjectActivity: vi.fn() } as never
    Reflect.deleteProperty(window.api[namespace], method)
    const compute = await renderPage()
    expect(compute.disabled).toBe(true)
    await act(async () => compute.click())
    expect(usePreviewWorkbenchStore.getState().activeItemId).not.toBe(PROJECT_COMPUTE_PREVIEW_ID)
  })

  it('keeps Compute disabled until session persistence is ready', async () => {
    const compute = await renderPage(false)
    expect(compute.disabled).toBe(true)
    await act(async () => compute.click())
    expect(usePreviewWorkbenchStore.getState().activeItemId).not.toBe(PROJECT_COMPUTE_PREVIEW_ID)
  })
})
