// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'

import type {
  NotebookEnvironmentStatus,
  NotebookRunRecord,
  NotebookSessionState
} from '../../../../shared/notebook'
import type { ProvisionStatus } from '../../../../shared/notebook-env'
import { createInitialNotebookEnvState, useNotebookEnvStore } from '../../stores/notebook-env-store'
import { createInitialSettingsState, useSettingsStore } from '../../stores/settings-store'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { EnvProvisionOverlay } from './EnvProvisionOverlay'
import { NotebookPreview, type NotebookPreviewItem } from './NotebookPreview'
import { deriveProvisionUi } from './provisioning-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

const notebookCodeBlockSpy = vi.hoisted(() => vi.fn())

vi.mock('./notebook-code', () => ({
  NotebookCodeBlock: (props: { code: string; language?: string; highlightLine?: number }) => {
    notebookCodeBlockSpy(props)
    return <pre data-testid="notebook-code-block">{props.code}</pre>
  }
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  notebookCodeBlockSpy.mockClear()
  useNotebookEnvStore.setState(createInitialNotebookEnvState())
  useSettingsStore.setState(createInitialSettingsState())
  useSessionStore.setState({
    ...createInitialSessionState(),
    sessions: [
      {
        id: 'session-1',
        conversationGraph: {
          rootFrameId: 'root-frame-session-1',
          frames: [
            { id: 'root-frame-session-1', kind: 'root' },
            { id: 'frame-child', kind: 'delegate', delegateName: 'Evidence check' }
          ]
        }
      }
    ]
  } as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  await i18next.changeLanguage('en')
})

describe('EnvProvisionOverlay', () => {
  it('localizes main-process progress copy instead of rendering IPC English', async () => {
    await act(async () => i18next.changeLanguage('zh-Hans'))
    const ui = deriveProvisionUi(
      { pythonReady: false, rReady: false, version: 3, provisioning: true },
      'python',
      {
        phase: 'fetch-python',
        event: { code: 'preparing-packages', environment: 'default-python' },
        progress: 0.1
      },
      undefined
    )

    act(() => root.render(<EnvProvisionOverlay ui={ui} />))

    expect(container.textContent).toContain('正在准备 default-python 软件包…')
    expect(container.textContent).not.toContain('Preparing default-python packages…')
  })

  it('shows the python preparation message and progress', () => {
    const ui = deriveProvisionUi(
      { pythonReady: false, rReady: false, version: 3, provisioning: true },
      'python',
      {
        phase: 'create-python',
        event: { code: 'environment-create', environment: 'default-python' },
        progress: 0.5
      },
      undefined
    )
    act(() => root.render(<EnvProvisionOverlay ui={ui} />))
    const gate = container.querySelector('[data-testid="notebook-env-gate"]')
    expect(gate?.textContent).toContain('Preparing Python environment')
    const progressBar = gate?.querySelector<HTMLElement>('[style*="scaleX"]')
    expect(progressBar?.className).toContain('transition-transform')
    expect(progressBar?.className).toContain('motion-reduce:transition-none')
    expect(progressBar?.className).not.toContain('transition-all')
  })

  it('announces preparation progress with progressbar semantics', () => {
    const ui = deriveProvisionUi(
      { pythonReady: false, rReady: false, version: 3, provisioning: true },
      'python',
      {
        phase: 'create-python',
        event: { code: 'environment-create', environment: 'default-python' },
        progress: 0.5
      },
      undefined
    )
    act(() => root.render(<EnvProvisionOverlay ui={ui} />))

    const gate = container.querySelector('[data-testid="notebook-env-gate"]')
    expect(gate?.getAttribute('role')).toBe('status')
    expect(gate?.getAttribute('aria-live')).toBe('polite')
    const progressBar = gate?.querySelector('[role="progressbar"]')
    expect(progressBar?.getAttribute('aria-valuemin')).toBe('0')
    expect(progressBar?.getAttribute('aria-valuemax')).toBe('100')
    expect(progressBar?.getAttribute('aria-valuenow')).toBe('50')
  })

  it('renders a retry affordance in the error state', () => {
    let retried = 0
    act(() =>
      root.render(
        <EnvProvisionOverlay
          ui={{ kind: 'error', message: 'offline' }}
          onRetry={() => (retried += 1)}
        />
      )
    )
    const button = container.querySelector(
      '[data-testid="notebook-env-retry"]'
    ) as HTMLButtonElement
    expect(button).not.toBeNull()
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(retried).toBe(1)
  })

  it('announces setup failures assertively', () => {
    act(() => root.render(<EnvProvisionOverlay ui={{ kind: 'error', message: 'offline' }} />))
    const gate = container.querySelector('[data-testid="notebook-env-gate"]')
    expect(gate?.getAttribute('role')).toBe('alert')
    expect(gate?.getAttribute('aria-live')).toBe('assertive')
  })

  it('renders nothing when ready', () => {
    act(() => root.render(<EnvProvisionOverlay ui={{ kind: 'ready' }} />))
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()
  })
})

// D3-review recipe: mount the real NotebookPreview with a never-resolving notebook.state() (so it
// stays perpetually loading/inert) and assert the gate tracks useNotebookEnvStore state directly,
// proving the gate wiring survives inside the actual pane rather than only in EnvProvisionOverlay
// isolation above.
describe('NotebookPreview env gate (mounted)', () => {
  const item: NotebookPreviewItem = {
    id: 'tool:notebook:test-session',
    sessionId: 'session-1',
    title: 'Notebook',
    type: 'tool',
    toolKind: 'notebook',
    notebook: {
      sessionId: 'session-1',
      projectId: 'proj',
      workspaceCwd: '/tmp/proj',
      notebookSessionRoot: '/tmp/proj/.notebook',
      dataRoot: '/tmp/proj/.notebook/data',
      runtimeRoot: '/tmp/proj/.notebook/runtime',
      runJsonPath: '/tmp/proj/.notebook/run.json'
    }
  }

  beforeEach(() => {
    window.api = {
      notebook: {
        // Never resolves, so the pane stays inert for the duration of the test.
        state: vi.fn(() => new Promise(() => {})),
        onChanged: vi.fn(() => vi.fn())
      },
      notebookEnv: {
        getStatus: vi.fn(() => Promise.resolve(createInitialNotebookEnvState().status)),
        provision: vi.fn(() => Promise.resolve()),
        onProgress: vi.fn(() => vi.fn())
      }
    } as never
  })

  it('shows notebook-env-gate while preparing and hides it once python is ready', () => {
    const preparingStatus: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 1,
      provisioning: true
    }
    useNotebookEnvStore.setState({
      status: preparingStatus,
      ui: deriveProvisionUi(preparingStatus, undefined, undefined, undefined)
    })

    act(() => root.render(<NotebookPreview item={item} />))
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).not.toBeNull()

    const readyStatus: ProvisionStatus = {
      pythonReady: true,
      rReady: false,
      version: 1,
      provisioning: false
    }
    act(() => {
      useNotebookEnvStore.setState({
        status: readyStatus,
        ui: deriveProvisionUi(readyStatus, undefined, undefined, undefined)
      })
    })

    expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()
  })

  it('does not cover this notebook for another session provisioning run', () => {
    const preparingStatus: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 1,
      provisioning: true
    }
    useNotebookEnvStore.setState({
      status: preparingStatus,
      ui: deriveProvisionUi(
        preparingStatus,
        undefined,
        {
          phase: 'fetch-python',
          event: { code: 'downloading-python-runtime' },
          progress: 0.25,
          scope: 'python',
          sessionId: 'session-2'
        },
        undefined
      )
    })

    act(() => root.render(<NotebookPreview item={item} />))

    expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()
  })

  it('only covers the session whose automatic Python preparation failed', () => {
    const failedStatus: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 1,
      provisioning: false
    }
    const failedProgress = {
      phase: 'error' as const,
      diagnostic: 'Python download failed',
      progress: 0,
      scope: 'python' as const
    }
    useNotebookEnvStore.setState({
      status: failedStatus,
      ui: deriveProvisionUi(
        failedStatus,
        undefined,
        { ...failedProgress, sessionId: 'session-2' },
        failedProgress.diagnostic
      )
    })

    act(() => root.render(<NotebookPreview item={item} />))
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()

    act(() => {
      useNotebookEnvStore.setState({
        ui: deriveProvisionUi(
          failedStatus,
          undefined,
          { ...failedProgress, sessionId: 'session-1' },
          failedProgress.diagnostic
        )
      })
    })
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).not.toBeNull()
  })

  it('shows the initial notebook state failure even when no kernel terminal exists', async () => {
    vi.mocked(window.api.notebook.state).mockRejectedValueOnce(
      new Error('Could not load notebook state')
    )

    await act(async () => {
      root.render(<NotebookPreview item={item} />)
    })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    expect(container.textContent).toContain('Could not load notebook state')

    vi.mocked(window.api.notebook.state).mockResolvedValueOnce({
      id: 'session-1',
      sessionId: 'session-1',
      cwd: '/tmp/proj',
      notebookSessionRoot: '/tmp/proj/.notebook',
      dataRoot: '/tmp/proj/.notebook/data',
      runtimeRoot: '/tmp/proj/.notebook/runtime',
      kernelStatus: 'idle',
      runJsonPath: '/tmp/proj/.notebook/run.json',
      cells: [],
      runCount: 0,
      runs: [],
      recentRuns: [],
      environments: [],
      latestRunEnvironments: {}
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    expect(window.api.notebook.state).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Could not load notebook state')
  })
})

// Minimal NotebookRunRecord builder, mirroring SessionNotebookDialog.render.test.tsx's makeRun.
const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'r1',
  cellId: 'c1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'completed',
  startedAt: 0,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  rootFrameId: 'root-frame-session-1',
  agentFrameId: 'root-frame-session-1',
  ...overrides
})

describe('NotebookPreview per-kernel tabs', () => {
  const item: NotebookPreviewItem = {
    id: 'tool:notebook:test-session',
    sessionId: 'session-1',
    title: 'Notebook',
    type: 'tool',
    toolKind: 'notebook',
    notebook: {
      sessionId: 'session-1',
      projectId: 'proj',
      workspaceCwd: '/tmp/proj',
      notebookSessionRoot: '/tmp/proj/.notebook',
      dataRoot: '/tmp/proj/.notebook/data',
      runtimeRoot: '/tmp/proj/.notebook/runtime',
      runJsonPath: '/tmp/proj/.notebook/run.json'
    }
  }

  const mountWithRuns = async (
    runs: NotebookRunRecord[],
    environments: NotebookEnvironmentStatus[] = [],
    runStaleness: NotebookSessionState['runStaleness'] = {},
    kernelStatus: NotebookSessionState['kernelStatus'] = 'idle',
    stateOverrides: Partial<NotebookSessionState> = {}
  ): Promise<void> => {
    const readyStatus: ProvisionStatus = {
      pythonReady: true,
      rReady: true,
      version: 1,
      provisioning: false
    }
    useNotebookEnvStore.setState({
      status: readyStatus,
      ui: deriveProvisionUi(readyStatus, undefined, undefined, undefined)
    })
    const liveEnvironments =
      environments.length > 0
        ? environments
        : Array.from(
            new Map(
              runs
                .filter((run) => run.kernelKind === 'python' || run.kernelKind === 'r')
                .map((run) => {
                  const environment =
                    run.environment ?? (run.kernelKind === 'r' ? 'default-r' : 'default-python')
                  const processKey = `${run.kernelKind}:${environment}`
                  return [
                    processKey,
                    {
                      processKey,
                      kind: run.kernelKind as 'python' | 'r',
                      environment,
                      status: 'idle' as const
                    }
                  ] as const
                })
            ).values()
          )

    window.api = {
      notebook: {
        state: vi.fn(() =>
          Promise.resolve({
            id: 'session-1',
            sessionId: 'session-1',
            cwd: '/tmp/proj',
            notebookSessionRoot: '/tmp/proj/.notebook',
            dataRoot: '/tmp/proj/.notebook/data',
            runtimeRoot: '/tmp/proj/.notebook/runtime',
            kernelStatus,
            runJsonPath: '/tmp/proj/.notebook/run.json',
            cells: [],
            runCount: runs.length,
            runs,
            recentRuns: runs,
            runStaleness,
            environments: liveEnvironments,
            ...stateOverrides
          })
        ),
        inspectNamespace: vi.fn((request) =>
          Promise.resolve({
            status: 'available' as const,
            language: request.language,
            environment: request.environment,
            kernelEpochId: 'epoch-1',
            variableCount: request.includePrivate ? 2 : 1,
            variablesTruncated: false,
            variables: [
              {
                name: 'frame',
                type: 'matplotlib.figure.Figure',
                shape: '1 axes',
                sizeBytes: 256,
                preview: 'Figure (1 axes)'
              },
              ...(request.includePrivate
                ? [
                    {
                      name: '_private',
                      type: 'str',
                      sizeBytes: 7,
                      preview: "'value'",
                      private: true
                    }
                  ]
                : [])
            ]
          })
        ),
        execute: vi.fn(() => Promise.resolve({})),
        restart: vi.fn(),
        onChanged: vi.fn(() => vi.fn())
      },
      notebookEnv: {
        getStatus: vi.fn(() => Promise.resolve(readyStatus)),
        provision: vi.fn(() => Promise.resolve()),
        onProgress: vi.fn(() => vi.fn())
      }
    } as never

    await act(async () => {
      root.render(<NotebookPreview item={item} />)
    })
    // Flush the mount-deferred setTimeout(0) that kicks off loadNotebookState(), plus its state()
    // promise resolution and the resulting re-render — React's passive effects also queue via a
    // macrotask in this jsdom test environment, so this needs a few real event-loop turns.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('uses one notebook scroll owner and an accessible real resize handle', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })])

    const split = container.querySelector<HTMLElement>('[data-group]')
    const cellsPanel = container.querySelector<HTMLElement>('[data-panel]')
    const cellsPanelContent = cellsPanel?.firstElementChild as HTMLElement | undefined
    const cells = container.querySelector<HTMLElement>('[data-testid="notebook-cells"]')
    const divider = container.querySelector<HTMLElement>('[data-separator]')

    expect(split?.hasAttribute('data-group')).toBe(true)
    expect(split?.className).toContain('flex-col')
    expect(cellsPanel?.hasAttribute('data-panel')).toBe(true)
    expect(cellsPanelContent?.className).toContain('overflow-hidden')
    expect(cells?.className).toContain('overflow-y-auto')
    expect(cells?.parentElement).toBe(cellsPanelContent)
    expect(divider?.getAttribute('role')).toBe('separator')
    expect(divider?.getAttribute('aria-label')).toBe('Resize notebook and terminal')
    expect(divider?.getAttribute('aria-orientation')).toBe('horizontal')
    const terminalHeader = container.querySelector('[data-testid="notebook-terminal-header"]')
    expect(terminalHeader?.textContent).toContain('Python kernel')
    expect(divider?.contains(terminalHeader)).toBe(true)
    expect(divider?.className).toContain('before:opacity-60')
    expect(container.querySelector('[data-slot="message-scroller-button"]')).toBeNull()
    expect(container.querySelector('[aria-label="Scroll to end"]')).toBeNull()
  })

  it('opens a bounded live namespace snapshot and reloads when private names are shown', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Inspect variables' }))
    })

    expect(container.querySelector('[data-testid="notebook-variables-view"]')).not.toBeNull()
    expect(screen.getByText('matplotlib.figure.Figure')).toBeTruthy()
    expect(screen.getByText('Figure (1 axes)')).toBeTruthy()
    expect(screen.queryByText('_private')).toBeNull()
    expect(window.api.notebook.inspectNamespace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        language: 'python',
        environment: 'default-python',
        includePrivate: false
      })
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Show private variables' }))
    })

    expect(screen.getByText('_private')).toBeTruthy()
    expect(window.api.notebook.inspectNamespace).toHaveBeenLastCalledWith(
      expect.objectContaining({ includePrivate: true })
    )
  })

  it('suggests live variables and accepts the active option without executing', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })])
    vi.mocked(window.api.notebook.inspectNamespace).mockResolvedValue({
      status: 'available',
      language: 'python',
      environment: 'default-python',
      kernelEpochId: 'epoch-1',
      variableCount: 2,
      variablesTruncated: false,
      variables: [
        { name: 'frame', type: 'DataFrame', preview: '3 rows' },
        { name: 'frameCount', type: 'int', preview: '3' }
      ]
    })

    const input = container.querySelector(
      '[data-testid="kernel-terminal-input"]'
    ) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'fr' } })

    const listbox = await screen.findByRole('listbox', { name: 'Variables' })
    const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual(['frameDataFrame', 'frameCountint'])
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Variables' })).toBeNull()
    fireEvent.change(input, { target: { value: 'f' } })
    const reopened = await screen.findByRole('listbox', { name: 'Variables' })
    const reopenedOptions = [...reopened.querySelectorAll<HTMLElement>('[role="option"]')]

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(reopenedOptions[1]?.getAttribute('aria-selected')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(reopenedOptions[1]?.id)

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('frameCount')
    expect(window.api.notebook.execute).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox', { name: 'Variables' })).toBeNull()
  })

  it('replaces the identifier at the caret and leaves IME input untouched', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })])

    const input = container.querySelector(
      '[data-testid="kernel-terminal-input"]'
    ) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'print(fr + 1)' } })
    input.setSelectionRange(8, 8)
    fireEvent.select(input)
    await screen.findByRole('listbox', { name: 'Variables' })

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(input.value).toBe('print(fr + 1)')
    expect(window.api.notebook.execute).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('print(frame + 1)')
    expect(input.selectionStart).toBe(11)
    expect(input.selectionEnd).toBe(11)
  })

  it('closes variable suggestions as soon as the selected kernel becomes busy', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })])

    const input = container.querySelector(
      '[data-testid="kernel-terminal-input"]'
    ) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'fr' } })
    await screen.findByRole('listbox', { name: 'Variables' })

    const state = vi.mocked(window.api.notebook.state)
    const idleState = await state.mock.results[0]?.value
    state.mockResolvedValue({
      ...idleState,
      activeRunId: 'p1',
      environments: idleState.environments.map((environment: NotebookEnvironmentStatus) => ({
        ...environment,
        status: 'running'
      }))
    })
    const onChanged = vi.mocked(window.api.notebook.onChanged).mock.calls[0]?.[0]

    await act(async () => {
      onChanged?.(item.notebook)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.queryByRole('listbox', { name: 'Variables' })).toBeNull()
    expect(input.disabled).toBe(true)
  })

  it('keeps notebook controls mounted for the responsive variables layout', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })])

    const cellsBeforeOpen = container.querySelector('[data-testid="notebook-cells"]')
    const terminalBeforeOpen = container.querySelector('[data-testid="kernel-terminal-input"]')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Inspect variables' }))
    })

    const primaryView = container.querySelector<HTMLElement>(
      '[data-testid="notebook-primary-view"]'
    )
    const variablesView = container.querySelector<HTMLElement>(
      '[data-testid="notebook-variables-view"]'
    )

    expect(primaryView).not.toBeNull()
    expect(primaryView?.className).toContain('flex-col')
    expect(primaryView?.className).toContain('hidden')
    expect(primaryView?.className).toContain('@min-[55rem]/notebook:flex')
    expect(primaryView?.querySelector('[data-testid="notebook-cells"]')).toBe(cellsBeforeOpen)
    expect(primaryView?.querySelector('[data-testid="kernel-terminal-input"]')).toBe(
      terminalBeforeOpen
    )
    expect(variablesView?.className).toContain('@min-[55rem]/notebook:basis-[40%]')
    expect(variablesView?.className).toContain('@min-[55rem]/notebook:border-l')

    const closeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="notebook-variables-close"]'
    )
    fireEvent.focus(closeButton as HTMLButtonElement)
    await screen.findByRole('tooltip')
    expect(
      document.body.querySelector<HTMLElement>('[data-slot="tooltip-content"]')?.className
    ).toContain('z-[70]')

    const variablesButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="notebook-variables-button"]'
    )
    expect(variablesButton?.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      fireEvent.click(variablesButton as HTMLButtonElement)
    })

    expect(container.querySelector('[data-testid="notebook-variables-view"]')).toBeNull()
    expect(container.querySelector('[data-testid="notebook-cells"]')).toBe(cellsBeforeOpen)
    expect(container.querySelector('[data-testid="kernel-terminal-input"]')).toBe(
      terminalBeforeOpen
    )
    expect(
      container
        .querySelector('[data-testid="notebook-variables-button"]')
        ?.getAttribute('aria-pressed')
    ).toBe('false')
  })

  it('clears a live namespace snapshot when its kernel terminates', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Inspect variables' }))
    })
    expect(screen.getByText('frame')).toBeTruthy()

    const state = vi.mocked(window.api.notebook.state)
    const liveState = await state.mock.results[0]?.value
    state.mockResolvedValue({
      ...liveState,
      kernelStatus: 'terminated',
      environments: liveState.environments.map((environment: NotebookEnvironmentStatus) => ({
        ...environment,
        status: 'terminated'
      }))
    })
    const onChanged = vi.mocked(window.api.notebook.onChanged).mock.calls[0]?.[0]

    await act(async () => {
      onChanged?.(item.notebook)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.queryByText('frame')).toBeNull()
    expect(screen.getByText('No live namespace')).toBeTruthy()
  })

  it('reloads an open namespace after its R kernel restarts', async () => {
    await mountWithRuns(
      [makeRun({ runId: 'r1', kernelKind: 'r', environment: 'default-r' })],
      [
        {
          processKey: 'r:default-r',
          kind: 'r',
          environment: 'default-r',
          status: 'idle',
          restartRecommended: true
        }
      ]
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Inspect variables' }))
    })
    expect(window.api.notebook.inspectNamespace).toHaveBeenCalledTimes(1)

    const state = vi.mocked(window.api.notebook.state)
    const liveState = await state.mock.results[0]?.value
    vi.mocked(window.api.notebook.restart).mockResolvedValue({
      ...liveState,
      environments: liveState.environments.map((environment: NotebookEnvironmentStatus) => ({
        ...environment,
        restartRecommended: false
      }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart R kernel' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(window.api.notebook.restart).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'r', environment: 'default-r' })
    )
    expect(window.api.notebook.inspectNamespace).toHaveBeenCalledTimes(2)
    expect(window.api.notebook.inspectNamespace).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: 'r', environment: 'default-r' })
    )
  })

  it('renders terminated notebook history as view-only without terminal controls', async () => {
    await mountWithRuns(
      [
        makeRun({ runId: 'p1', kernelKind: 'python', script: 'print(1)' }),
        makeRun({ runId: 'p2', kernelKind: 'python', script: 'print(2)' })
      ],
      [],
      {},
      'terminated'
    )

    expect(container.querySelectorAll('[data-testid="notebook-cell"]')).toHaveLength(2)
    expect(container.querySelector('[data-testid="kernel-terminal"]')).toBeNull()
    expect(container.querySelector('[data-testid="kernel-terminal-input"]')).toBeNull()
    expect(container.querySelector('[data-separator]')).toBeNull()
    expect(container.querySelector('[data-testid="notebook-read-only-status"]')?.textContent).toBe(
      "Python · view only; this kernel's namespace no longer exists2 cells"
    )
  })

  it('keeps persisted idle history view-only until this app process activates its kernel', async () => {
    await mountWithRuns(
      [makeRun({ runId: 'p1', kernelKind: 'python', script: 'x = 42' })],
      [],
      {},
      'idle',
      { environments: [] }
    )

    expect(container.querySelector('[data-testid="kernel-terminal-input"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="notebook-read-only-status"]')?.textContent
    ).toContain("Python · view only; this kernel's namespace no longer exists")

    const state = vi.mocked(window.api.notebook.state)
    const persistedState = await state.mock.results[0]?.value
    state.mockResolvedValue({
      ...persistedState,
      environments: [
        {
          processKey: 'python:default-python',
          kind: 'python',
          environment: 'default-python',
          status: 'idle'
        }
      ]
    })
    const onChanged = vi.mocked(window.api.notebook.onChanged).mock.calls[0]?.[0]

    await act(async () => {
      onChanged?.(item.notebook)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.querySelector('[data-testid="notebook-read-only-status"]')).toBeNull()
    expect(container.querySelector('[data-testid="kernel-terminal-input"]')).not.toBeNull()
  })

  it('describes later variable changes without implying an execution error', async () => {
    await mountWithRuns(
      [
        makeRun({ runId: 'run-1', cellId: 'prepare-data', script: 'x = 1' }),
        makeRun({ runId: 'run-2', cellId: 'make-result', script: 'y = x + 1' }),
        makeRun({ runId: 'run-3', cellId: 'update-data', script: 'x = 2' })
      ],
      [],
      {
        'run-2': {
          state: 'stale',
          causedByRunId: 'run-3',
          names: ['x'],
          path: ['run-1', 'run-2']
        }
      }
    )

    const badge = container.querySelector<HTMLButtonElement>('[data-testid="notebook-cell-stale"]')
    expect(badge?.textContent).toBe('Variable changed after this run')
    expect(badge?.querySelector('.lucide-variable')).not.toBeNull()
    expect(container.textContent).not.toContain(
      'Run [2] later changed x. This output is the snapshot recorded before that change; this run completed normally.'
    )
    fireEvent.focus(badge as HTMLButtonElement)
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Run [2] later changed x. This output is the snapshot recorded before that change; this run completed normally.'
    )
    expect(container.textContent).not.toContain('run-3')
    expect(container.textContent).not.toContain('out of date')
  })

  it('does not show a change notice when the alleged later run is absent', async () => {
    await mountWithRuns(
      [
        makeRun({ runId: 'run-0', cellId: 'define-x', script: 'x = [10, 20, 30]' }),
        makeRun({ runId: 'run-1', cellId: 'sum-x', script: 'y = sum(x)' })
      ],
      [],
      {
        'run-1': {
          state: 'stale',
          causedByRunId: 'run-3',
          names: ['x'],
          path: ['run-0', 'run-1']
        }
      }
    )

    expect(container.querySelector('[data-testid="notebook-cell-stale"]')).toBeNull()
    expect(container.textContent).not.toContain('Variable changed after this run')
  })

  it('describes incomplete dependency tracking without questioning the output', async () => {
    await mountWithRuns(
      [makeRun({ runId: 'run-2', cellId: 'make-result', script: 'model.refresh()' })],
      [],
      {
        'run-2': {
          state: 'unknown',
          reasons: ['opaque-mutation']
        }
      }
    )

    const badge = container.querySelector<HTMLButtonElement>(
      '[data-testid="notebook-cell-dependency-unknown"]'
    )
    expect(badge?.textContent).toBe('Variable tracking is limited')
    expect(badge?.querySelector('.lucide-variable')).not.toBeNull()
    expect(container.textContent).not.toContain(
      'This run completed normally. Some variable relationships in this code could not be determined automatically, so later variable changes may not be linked back to this run.'
    )
    fireEvent.focus(badge as HTMLButtonElement)
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'This run completed normally. Some variable relationships in this code could not be determined automatically, so later variable changes may not be linked back to this run.'
    )
    expect(container.textContent).not.toContain('result is current')
  })

  it('keeps incomplete-tracking metadata on every run when a cell is reused', async () => {
    await mountWithRuns(
      [
        makeRun({ runId: 'run-1', cellId: 'shared-cell', script: 'x = 1' }),
        makeRun({ runId: 'run-2', cellId: 'shared-cell', script: 'x = 2' })
      ],
      [],
      {
        'run-1': {
          state: 'unknown',
          reasons: ['opaque-mutation']
        },
        'run-2': {
          state: 'unknown',
          reasons: ['opaque-mutation']
        }
      }
    )

    expect(container.textContent?.match(/Variable tracking is limited/g)).toHaveLength(2)
  })

  it('keeps later-update metadata on an earlier execution when a cell is reused', async () => {
    await mountWithRuns(
      [
        makeRun({ runId: 'run-1', cellId: 'shared-cell', script: 'x = 1' }),
        makeRun({ runId: 'run-2', cellId: 'shared-cell', script: 'x = 2' })
      ],
      [],
      {
        'run-1': {
          state: 'stale',
          causedByRunId: 'run-2',
          names: ['x'],
          path: ['run-1']
        },
        'run-2': { state: 'clear' }
      }
    )

    expect(container.querySelector('[data-testid="notebook-cell-stale"]')).not.toBeNull()
  })

  it('shows a change notice when its cause is later in the selected Agent Frame', async () => {
    await mountWithRuns(
      [
        makeRun({
          runId: 'root-run',
          cellId: 'shared-cell',
          rootFrameId: 'root-frame-session-1',
          agentFrameId: 'root-frame-session-1'
        }),
        makeRun({
          runId: 'child-run',
          cellId: 'shared-cell',
          rootFrameId: 'root-frame-session-1',
          agentFrameId: 'child-frame-session-1'
        }),
        makeRun({
          runId: 'root-update',
          cellId: 'root-update-cell',
          rootFrameId: 'root-frame-session-1',
          agentFrameId: 'root-frame-session-1'
        })
      ],
      [],
      {
        'root-run': {
          state: 'stale',
          causedByRunId: 'root-update',
          names: ['x'],
          path: ['root-run']
        },
        'child-run': { state: 'clear' }
      }
    )

    expect(container.querySelector('[data-testid="notebook-cell-stale"]')).not.toBeNull()
  })

  // The header's three strings were unwrapped while their translations already sat in the catalog —
  // the shape a textual merge leaves behind. English assertions above stay green through that, so
  // the locale is what has to be asserted.
  it('translates the terminal header and the resize handle', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python' }),
      makeRun({ runId: 'r1', kernelKind: 'r' })
    ])
    await act(async () => i18next.changeLanguage('zh-Hans'))

    const header = container.querySelector('[data-testid="notebook-terminal-header"]')
    expect(header?.textContent).toContain('Python 内核 · 与智能体共享')
    expect(header?.textContent).toContain('空闲')
    expect(header?.textContent).not.toContain('shared with the agent')
    expect(header?.textContent).not.toContain('idle')
    expect(
      container.querySelector<HTMLElement>('[data-separator]')?.getAttribute('aria-label')
    ).toBe('调整 Notebook 与终端大小')

    fireEvent.click(
      container.querySelector('[data-testid="kernel-switcher-r"]') as HTMLButtonElement
    )
    expect(header?.textContent).toContain('R 内核 · 与智能体共享')

    await act(async () => i18next.changeLanguage('en'))
  })

  it('shows only kernels present in the projected history', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python' }),
      makeRun({ runId: 'x1', kernelKind: 'repl', script: 'await host.notebook.run(...)' }),
      makeRun({ runId: 'b1', kernelKind: 'bash', script: 'ls -la' })
    ])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-python"]')).not.toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-repl"]')?.textContent).toBe(
      'Agent SDK'
    )
    expect(switcher.querySelector('[data-testid="kernel-switcher-bash"]')?.textContent).toBe('Bash')
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).toBeNull()
  })

  it('projects named Main Agent and Subagent Runs without All, legacy, or Frame IDs', async () => {
    await mountWithRuns([
      makeRun({
        runId: 'root',
        script: 'print("root")',
        rootFrameId: 'root-frame-session-1',
        agentFrameId: 'root-frame-session-1'
      }),
      makeRun({ runId: 'child', script: 'print("child")', agentFrameId: 'frame-child' }),
      makeRun({
        runId: 'legacy',
        script: 'print("legacy")',
        rootFrameId: undefined,
        agentFrameId: undefined
      })
    ])

    const filter = container.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Filter notebook runs by Agent"]'
    )
    expect(filter?.textContent).toContain('Main Agent · 1 run')
    expect(filter?.className).toContain('focus-visible:ring-3')
    expect(filter?.className).not.toContain('focus-visible:ring-2')
    expect(filter?.textContent).not.toContain('All')
    expect(filter?.textContent).not.toContain('Unattributed')
    expect(filter?.textContent).not.toContain('frame-child')

    await act(async () => {
      if (filter) fireEvent.click(filter)
    })
    const childOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('Evidence check · 1 run')
    )
    expect(childOption).toBeDefined()
    await act(async () => {
      if (childOption) fireEvent.click(childOption)
    })

    expect(container.textContent).toContain('print("child")')
    expect(container.textContent).not.toContain('print("root")')
    expect(container.textContent).not.toContain('print("legacy")')
  })

  it('keeps user input in the Main Agent view after a pending Session binds its final ID', async () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          conversationGraph: {
            rootFrameId: 'root-frame-pending-session-1',
            frames: [{ id: 'root-frame-pending-session-1', kind: 'root' }]
          }
        }
      ]
    } as never)

    await mountWithRuns([
      makeRun({
        runId: 'agent-run',
        script: 'print("agent")',
        rootFrameId: 'root-frame-pending-session-1',
        agentFrameId: 'root-frame-pending-session-1'
      }),
      makeRun({
        runId: 'user-run',
        source: 'user',
        inputKind: 'terminal',
        script: 'print("user")',
        rootFrameId: undefined,
        agentFrameId: 'root-frame-session-1'
      })
    ])

    const filter = container.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Filter notebook runs by Agent"]'
    )
    expect(filter?.textContent).toContain('Main Agent · 2 runs')
    expect(container.textContent).toContain('print("agent")')
    expect(container.textContent).toContain('print("user")')
    const userCell = [...container.querySelectorAll('[data-testid="notebook-cell"]')].find((cell) =>
      cell.textContent?.includes('print("user")')
    )
    expect(userCell?.textContent).toContain('you')
    const userBadge = [...(userCell?.querySelectorAll('span') ?? [])].find(
      (badge) => badge.textContent === 'you'
    )
    expect(userBadge?.className).toContain('bg-blue-500/10')
    expect(userBadge?.className).toContain('text-blue-700')
    expect(userBadge?.className).toContain('dark:text-blue-300')
  })

  it('shows no kernel tabs before a kernel has produced a run', async () => {
    await mountWithRuns([])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-python"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-repl"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-bash"]')).toBeNull()
    expect(container.querySelector('[data-testid="kernel-terminal-input"]')).toBeNull()
  })

  it('hides unused R, Agent SDK, and Bash tabs for a python-only run set', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python' }),
      makeRun({ runId: 'p2', kernelKind: 'python' })
    ])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-python"]')).not.toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-repl"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-bash"]')).toBeNull()
  })

  it("shows only the active kind's cells, and switches on tab click", async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python', script: 'print("py")' }),
      makeRun({ runId: 'x1', kernelKind: 'repl', script: 'host.notebook.run(...)' })
    ])

    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('print("py")')
    expect(container.textContent).not.toContain('host.notebook.run')

    const replTab = container.querySelector(
      '[data-testid="kernel-switcher-repl"]'
    ) as HTMLButtonElement
    act(() => replTab.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('host.notebook.run')
    expect(container.textContent).not.toContain('print("py")')
  })

  it('shows and selects only R when only R history exists', async () => {
    await mountWithRuns([makeRun({ runId: 'r1', kernelKind: 'r', script: 'print("r")' })])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    const rTab = switcher.querySelector('[data-testid="kernel-switcher-r"]') as HTMLButtonElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-python"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-repl"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-bash"]')).toBeNull()
    expect(rTab.className).toContain('bg-bg-300')
    expect(container.textContent).toContain('print("r")')
  })

  it('shows and selects only Agent SDK when only Agent SDK history exists', async () => {
    await mountWithRuns([
      makeRun({ runId: 'x1', kernelKind: 'repl', script: 'host.notebook.run(...)' })
    ])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    const replTab = switcher.querySelector(
      '[data-testid="kernel-switcher-repl"]'
    ) as HTMLButtonElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-python"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-bash"]')).toBeNull()
    expect(replTab.className).toContain('bg-bg-300')

    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('host.notebook.run')
  })

  it('routes R input to the selected kernel and renders the result as a you call block', async () => {
    const runs = [
      makeRun({
        runId: 'p1',
        kernelKind: 'python',
        inputKind: 'terminal',
        script: 'print("python")'
      }),
      makeRun({ runId: 'r1', kernelKind: 'r', inputKind: 'terminal', script: 'print("r")' })
    ]
    await mountWithRuns(runs)

    fireEvent.click(
      container.querySelector('[data-testid="kernel-switcher-r"]') as HTMLButtonElement
    )
    const scrollback = container.querySelector('[data-testid="kernel-terminal-scrollback"]')
    expect(scrollback?.textContent).toContain('> print("r")')
    expect(scrollback?.textContent).not.toContain('print("python")')
    const execute = vi.mocked(window.api.notebook.execute)
    execute.mockImplementation(async (request) => {
      runs.push(
        makeRun({
          runId: 'user-r',
          cellId: 'user-r-cell',
          source: 'user',
          inputKind: 'terminal',
          kernelKind: request.language ?? 'python',
          environment: request.language === 'r' ? 'default-r' : 'default-python',
          script: request.code
        })
      )
      return {} as never
    })

    const input = container.querySelector(
      '[data-testid="kernel-terminal-input"]'
    ) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'x <- 1' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'x <- 1',
        source: 'user',
        inputKind: 'terminal',
        language: 'r'
      })
    )
    const userCell = [...container.querySelectorAll('[data-testid="notebook-cell"]')].find((cell) =>
      cell.textContent?.includes('x <- 1')
    )
    expect(userCell?.textContent).toContain('you')
    expect(userCell?.textContent).toContain('r')
  })

  it('lets the user cancel code reception and resume input without running partial code', async () => {
    const activeWrite = {
      cellId: 'unfinished',
      writeId: 'write-1',
      source: 'agent' as const,
      startedAt: 1
    }
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })], [], {}, 'idle', {
      activeWrite
    })
    const input = container.querySelector(
      '[data-testid="kernel-terminal-input"]'
    ) as HTMLTextAreaElement
    expect(input.disabled).toBe(true)
    const state = vi.mocked(window.api.notebook.state)
    const idleState = { ...(await state.mock.results[0]?.value), activeWrite: undefined }
    const abort = vi.fn(async () => {
      state.mockResolvedValue(idleState)
      return { sessionId: 'session-1', cellId: 'unfinished', code: '', status: 'idle' }
    })
    window.api.notebook.abortCodeCell = abort
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel code reception' }))
    })
    expect(abort).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        cellId: 'unfinished',
        writeId: 'write-1'
      })
    )
    expect(input.disabled).toBe(false)
    expect(window.api.notebook.execute).not.toHaveBeenCalled()
  })

  it('keeps cancellation failures visible after refreshing the active write', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })], [], {}, 'idle', {
      activeWrite: {
        cellId: 'unfinished',
        writeId: 'write-1',
        source: 'agent',
        startedAt: 1
      }
    })
    const state = vi.mocked(window.api.notebook.state)
    state.mockClear()
    window.api.notebook.abortCodeCell = vi.fn().mockRejectedValue(new Error('Cancellation failed'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel code reception' }))
    })

    expect(state).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Cancellation failed')
    expect(
      (screen.getByRole('button', { name: 'Cancel code reception' }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(
      (container.querySelector('[data-testid="kernel-terminal-input"]') as HTMLTextAreaElement)
        .disabled
    ).toBe(true)
  })

  it('queues idle terminal input until a background refresh confirms it is safe', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })])

    const state = vi.mocked(window.api.notebook.state)
    const idleState = await state.mock.results[0]?.value
    let resolveRefresh!: (value: typeof idleState) => void
    state.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRefresh = resolve as typeof resolveRefresh))
    )
    const onChanged = vi.mocked(window.api.notebook.onChanged).mock.calls[0]?.[0]

    await act(async () => {
      onChanged?.(item.notebook)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(
      container.querySelector('[data-testid="notebook-terminal-header"]')?.textContent
    ).toContain('idle')
    expect(
      (container.querySelector('[data-testid="kernel-terminal-input"]') as HTMLTextAreaElement)
        .disabled
    ).toBe(false)

    const input = container.querySelector(
      '[data-testid="kernel-terminal-input"]'
    ) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'print(42)' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(state).toHaveBeenCalledTimes(2)
    expect(window.api.notebook.execute).not.toHaveBeenCalled()

    await act(async () => {
      resolveRefresh(idleState)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(window.api.notebook.execute).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'print(42)', source: 'user' })
    )
  })

  it('does not submit from a stale idle snapshot when the fresh state is busy', async () => {
    await mountWithRuns([makeRun({ runId: 'p1', kernelKind: 'python' })])

    const state = vi.mocked(window.api.notebook.state)
    const idleState = await state.mock.results[0]?.value
    let resolveRefresh!: (value: typeof idleState) => void
    state.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRefresh = resolve as typeof resolveRefresh))
    )
    const onChanged = vi.mocked(window.api.notebook.onChanged).mock.calls[0]?.[0]

    await act(async () => {
      onChanged?.(item.notebook)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const input = container.querySelector(
      '[data-testid="kernel-terminal-input"]'
    ) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'print(42)' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(state).toHaveBeenCalledTimes(2)
    expect(window.api.notebook.execute).not.toHaveBeenCalled()
    expect(input.value).toBe('print(42)')

    await act(async () => {
      resolveRefresh({ ...idleState, activeRunId: 'agent-run' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(window.api.notebook.execute).not.toHaveBeenCalled()
    expect(input.value).toBe('print(42)')
  })

  it('shows selected-kernel status while retaining the notebook-wide input lock', async () => {
    await mountWithRuns(
      [
        makeRun({ runId: 'python-running', kernelKind: 'python', status: 'running' }),
        makeRun({ runId: 'r1', kernelKind: 'r' })
      ],
      [
        {
          processKey: 'r:default-r',
          kind: 'r',
          environment: 'default-r',
          status: 'idle'
        }
      ],
      {},
      'running',
      { activeRunId: 'python-running' }
    )

    expect(
      container.querySelector('[data-testid="notebook-terminal-header"]')?.textContent
    ).toContain('running')
    fireEvent.click(
      container.querySelector('[data-testid="kernel-switcher-r"]') as HTMLButtonElement
    )
    const header = container.querySelector('[data-testid="notebook-terminal-header"]')
    expect(header?.textContent).toContain('R kernel')
    expect(header?.textContent).toContain('idle')
    expect(
      (container.querySelector('[data-testid="kernel-terminal-input"]') as HTMLTextAreaElement)
        .disabled
    ).toBe(true)
  })

  it('hides data-kernel input on Agent SDK history and for a terminated selected R kernel', async () => {
    await mountWithRuns(
      [makeRun({ runId: 'r1', kernelKind: 'r' }), makeRun({ runId: 'x1', kernelKind: 'repl' })],
      [
        {
          processKey: 'r:default-r',
          kind: 'r',
          environment: 'default-r',
          status: 'terminated'
        }
      ]
    )

    fireEvent.click(
      container.querySelector('[data-testid="kernel-switcher-r"]') as HTMLButtonElement
    )
    expect(container.querySelector('[data-testid="kernel-terminal-input"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="notebook-read-only-status"]')?.textContent
    ).toContain("R · view only; this kernel's namespace no longer exists")

    fireEvent.click(
      container.querySelector('[data-testid="kernel-switcher-repl"]') as HTMLButtonElement
    )
    expect(container.querySelector('[data-testid="kernel-terminal-input"]')).toBeNull()
    expect(container.querySelector('[data-testid="notebook-read-only-status"]')).toBeNull()
  })

  it("renders a repl cell's origin label and uses the stored kernelKind for the language chip", async () => {
    await mountWithRuns([makeRun({ runId: 'x1', kernelKind: 'repl', script: 'x <- 1' })])

    const replTab = container.querySelector(
      '[data-testid="kernel-switcher-repl"]'
    ) as HTMLButtonElement
    act(() => replTab.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const cell = container.querySelector('[data-testid="notebook-cell"]') as HTMLElement
    expect(cell).not.toBeNull()
    // Stored kernelKind ('repl') wins over the R-looking script's detectCellLanguage heuristic.
    expect(cell.textContent).toContain('repl')
    expect(cell.querySelector('[data-testid="notebook-cell-origin"]')?.textContent).toBe('repl')
  })

  it('passes the active kernel language to notebook code blocks', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python', script: 'import pandas as pd' }),
      makeRun({ runId: 'r1', kernelKind: 'r', script: 'library(ggplot2)' }),
      makeRun({ runId: 'b1', kernelKind: 'bash', script: 'ls -la' }),
      makeRun({ runId: 'x1', kernelKind: 'repl', script: 'await host.notebook.run()' })
    ])

    expect(notebookCodeBlockSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'import pandas as pd', language: 'python' })
    )

    const clickTab = (testId: string): void => {
      const tab = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
      act(() => tab.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }

    clickTab('kernel-switcher-r')
    expect(notebookCodeBlockSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'library(ggplot2)', language: 'r' })
    )

    clickTab('kernel-switcher-bash')
    expect(notebookCodeBlockSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'ls -la', language: 'bash' })
    )

    clickTab('kernel-switcher-repl')
    expect(notebookCodeBlockSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'await host.notebook.run()', language: 'javascript' })
    )
  })
})

describe('NotebookPreview per-environment selector', () => {
  const item: NotebookPreviewItem = {
    id: 'tool:notebook:test-session',
    sessionId: 'session-1',
    title: 'Notebook',
    type: 'tool',
    toolKind: 'notebook',
    notebook: {
      sessionId: 'session-1',
      projectId: 'proj',
      workspaceCwd: '/tmp/proj',
      notebookSessionRoot: '/tmp/proj/.notebook',
      dataRoot: '/tmp/proj/.notebook/data',
      runtimeRoot: '/tmp/proj/.notebook/runtime',
      runJsonPath: '/tmp/proj/.notebook/run.json'
    }
  }

  const mountWithRuns = async (
    runs: NotebookRunRecord[],
    environments: NotebookEnvironmentStatus[] = [],
    executionEnvironments: NotebookSessionState['executionEnvironments'] = undefined,
    runtimeBindings: NotebookSessionState['runtimeBindings'] = undefined
  ): Promise<void> => {
    const readyStatus: ProvisionStatus = {
      pythonReady: true,
      rReady: false,
      version: 1,
      provisioning: false
    }
    useNotebookEnvStore.setState({
      status: readyStatus,
      ui: deriveProvisionUi(readyStatus, undefined, undefined, undefined)
    })
    const liveEnvironments =
      environments.length > 0
        ? environments
        : Array.from(
            new Map(
              runs
                .filter((run) => run.kernelKind === 'python' || run.kernelKind === 'r')
                .map((run) => {
                  const environment =
                    run.environment ?? (run.kernelKind === 'r' ? 'default-r' : 'default-python')
                  const processKey = `${run.kernelKind}:${environment}`
                  return [
                    processKey,
                    {
                      processKey,
                      kind: run.kernelKind as 'python' | 'r',
                      environment,
                      status: 'idle' as const
                    }
                  ] as const
                })
            ).values()
          )

    window.api = {
      notebook: {
        state: vi.fn(() =>
          Promise.resolve({
            id: 'session-1',
            sessionId: 'session-1',
            cwd: '/tmp/proj',
            notebookSessionRoot: '/tmp/proj/.notebook',
            dataRoot: '/tmp/proj/.notebook/data',
            runtimeRoot: '/tmp/proj/.notebook/runtime',
            kernelStatus: 'idle',
            runJsonPath: '/tmp/proj/.notebook/run.json',
            cells: [],
            runs,
            recentRuns: runs,
            environments: liveEnvironments,
            executionEnvironments,
            runtimeBindings
          })
        ),
        execute: vi.fn(() => Promise.resolve({})),
        onChanged: vi.fn(() => vi.fn())
      },
      notebookEnv: {
        getStatus: vi.fn(() => Promise.resolve(readyStatus)),
        provision: vi.fn(() => Promise.resolve()),
        onProgress: vi.fn(() => vi.fn())
      }
    } as never

    await act(async () => {
      root.render(<NotebookPreview item={item} />)
    })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('shows no env selector and all runs visible for single-env python runs (unchanged UX)', async () => {
    await mountWithRuns([
      makeRun({
        runId: 'p1',
        kernelKind: 'python',
        script: 'print(1)',
        environment: 'default-python'
      }),
      makeRun({
        runId: 'p2',
        kernelKind: 'python',
        script: 'print(2)',
        environment: 'default-python'
      })
    ])

    expect(container.querySelector('[data-testid="env-selector"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(2)
    expect(container.querySelector('[data-testid="kernel-switcher-python"]')?.textContent).toBe(
      'Python'
    )
  })

  it('shows the current python runtime binding while keeping a single environment selector hidden', async () => {
    await mountWithRuns(
      [
        makeRun({
          runId: 'p1',
          kernelKind: 'python',
          environment: 'default-python'
        })
      ],
      [],
      { python: 'default-python', r: 'default-r' },
      {
        python: {
          runtimeId: '/runtime/envs/pandas-demo2/bin/python',
          language: 'python',
          label: 'pandas-demo2',
          source: 'external',
          provenance: 'user-own',
          interpreterPath: '/runtime/envs/pandas-demo2/bin/python',
          version: 'Python 3.12.7',
          status: 'active'
        }
      }
    )

    expect(container.querySelector('[data-testid="env-selector"]')).toBeNull()
    expect(container.querySelector('[data-testid="kernel-switcher-python"]')?.textContent).toBe(
      'Python'
    )
    const badge = container.querySelector<HTMLButtonElement>(
      '[data-testid="notebook-runtime-binding"]'
    )
    expect(badge?.textContent).toBe('pandas-demo2')
    expect(badge?.className).toContain('max-w-')
    expect(badge?.querySelector('.truncate')).not.toBeNull()
    fireEvent.focus(badge as HTMLButtonElement)
    expect((await screen.findByRole('tooltip')).textContent).toBe('pandas-demo2 · Python 3.12.7')
    expect(container.querySelector('[data-testid="notebook-cell"]')?.textContent).not.toContain(
      'pandas-demo2'
    )
  })

  it.each([
    {
      language: 'python' as const,
      environment: 'external-python',
      runtimeId: '/usr/local/bin/python3',
      label: 'External Python'
    },
    {
      language: 'r' as const,
      environment: 'external-r',
      runtimeId: '/usr/local/bin/R',
      label: 'External R'
    }
  ])(
    'keeps an externally bound $language runtime usable when managed runtimes are unavailable',
    async ({ language, environment, runtimeId, label }) => {
      await mountWithRuns(
        [makeRun({ runId: `${language}-1`, kernelKind: language, environment })],
        [],
        { [language]: environment },
        {
          [language]: {
            runtimeId,
            language,
            label,
            source: 'external',
            provenance: 'user-own',
            interpreterPath: runtimeId,
            ...(language === 'r' ? { status: 'active' as const } : {})
          }
        }
      )

      const unavailableManagedStatus: ProvisionStatus = {
        pythonReady: false,
        rReady: false,
        version: 1,
        provisioning: false
      }
      act(() => {
        useNotebookEnvStore.setState({
          status: unavailableManagedStatus,
          ui: deriveProvisionUi(unavailableManagedStatus, undefined, undefined, undefined)
        })
      })

      expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()
      expect(
        (container.querySelector('[data-testid="kernel-terminal-input"]') as HTMLTextAreaElement)
          .disabled
      ).toBe(false)

      if (language === 'r') {
        await act(async () => {
          fireEvent.click(
            container.querySelector('[data-testid="kernel-switcher-r"]') as HTMLElement
          )
        })
        expect(window.api.notebookEnv.provision).not.toHaveBeenCalled()
      }
    }
  )

  it.each([
    {
      language: 'python' as const,
      environment: 'external-python',
      runtimeId: '/usr/local/bin/python3'
    },
    {
      language: 'r' as const,
      environment: 'external-r',
      runtimeId: '/usr/local/bin/R'
    }
  ])(
    'does not fall back to managed provisioning for an unavailable explicit $language binding',
    async ({ language, environment, runtimeId }) => {
      await mountWithRuns(
        [makeRun({ runId: `${language}-1`, kernelKind: language, environment })],
        [],
        { [language]: environment },
        {
          [language]: {
            runtimeId,
            language,
            label: `Unavailable ${language}`,
            source: 'external',
            provenance: 'user-own',
            interpreterPath: runtimeId,
            status: 'unavailable',
            reason: 'missing'
          }
        }
      )

      const unavailableManagedStatus: ProvisionStatus = {
        pythonReady: false,
        rReady: false,
        version: 1,
        provisioning: false
      }
      act(() => {
        useNotebookEnvStore.setState({
          status: unavailableManagedStatus,
          ui: deriveProvisionUi(unavailableManagedStatus, undefined, undefined, undefined)
        })
      })

      expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()
      expect(
        (container.querySelector('[data-testid="kernel-terminal-input"]') as HTMLTextAreaElement)
          .disabled
      ).toBe(true)
      expect(
        container.querySelector('[data-testid="notebook-runtime-binding-status"]')?.textContent
      ).toBe('Unavailable')

      const binding = container.querySelector<HTMLButtonElement>(
        '[data-testid="notebook-runtime-binding"]'
      )
      fireEvent.focus(binding as HTMLButtonElement)
      expect((await screen.findByRole('tooltip')).textContent).toContain('Missing')

      if (language === 'r') {
        await act(async () => {
          fireEvent.click(
            container.querySelector('[data-testid="kernel-switcher-r"]') as HTMLElement
          )
        })
        expect(window.api.notebookEnv.provision).not.toHaveBeenCalled()
      }
    }
  )

  it('shows the current R runtime binding on the R kernel tab', async () => {
    await mountWithRuns(
      [
        makeRun({
          runId: 'r1',
          kernelKind: 'r',
          environment: 'analysis'
        })
      ],
      [],
      { python: 'default-python', r: 'analysis' },
      {
        r: {
          runtimeId: '/runtime/envs/renv-analysis/bin/R',
          language: 'r',
          label: 'renv-analysis',
          source: 'managed',
          provenance: 'agent-created',
          interpreterPath: '/runtime/envs/renv-analysis/bin/R',
          status: 'active'
        }
      }
    )

    expect(container.querySelector('[data-testid="kernel-switcher-r"]')?.textContent).toBe('R')
    expect(container.querySelector('[data-testid="notebook-runtime-binding"]')?.textContent).toBe(
      'renv-analysis'
    )
  })

  it('opens Runtime settings from an unavailable binding', async () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({ openSettingsToPanel })
    await mountWithRuns(
      [makeRun({ runId: 'p1', kernelKind: 'python', environment: 'external-python' })],
      [],
      { python: 'external-python' },
      {
        python: {
          runtimeId: '/usr/local/bin/python3',
          language: 'python',
          label: 'External Python',
          source: 'external',
          provenance: 'user-own',
          interpreterPath: '/usr/local/bin/python3',
          status: 'unavailable',
          reason: 'disabled'
        }
      }
    )

    const binding = container.querySelector(
      '[data-testid="notebook-runtime-binding"]'
    ) as HTMLElement
    expect(binding.getAttribute('aria-label')).toContain('Open settings for External Python')
    fireEvent.click(binding)

    expect(openSettingsToPanel).toHaveBeenCalledWith('runtimes')
  })

  it('does not apply data runtime bindings to Agent SDK or Bash tabs', async () => {
    await mountWithRuns(
      [makeRun({ runId: 'x1', kernelKind: 'repl' }), makeRun({ runId: 'b1', kernelKind: 'bash' })],
      [],
      undefined,
      {
        python: {
          runtimeId: '/runtime/python',
          language: 'python',
          label: 'bound-python',
          source: 'managed',
          provenance: 'app-managed',
          interpreterPath: '/runtime/python',
          status: 'active'
        },
        r: {
          runtimeId: '/runtime/R',
          language: 'r',
          label: 'bound-r',
          source: 'managed',
          provenance: 'app-managed',
          interpreterPath: '/runtime/R',
          status: 'active'
        }
      }
    )

    expect(container.querySelector('[data-testid="kernel-switcher-repl"]')?.textContent).toBe(
      'Agent SDK'
    )
    expect(container.querySelector('[data-testid="kernel-switcher-bash"]')?.textContent).toBe(
      'Bash'
    )
    expect(container.querySelector('[data-testid="notebook-runtime-binding"]')).toBeNull()

    fireEvent.click(
      container.querySelector('[data-testid="kernel-switcher-bash"]') as HTMLButtonElement
    )
    expect(container.querySelector('[data-testid="notebook-runtime-binding"]')).toBeNull()
  })

  it('submits through the current custom runtime binding even when its selector is hidden', async () => {
    await mountWithRuns(
      [
        makeRun({
          runId: 'p1',
          kernelKind: 'python',
          environment: 'my-analysis'
        })
      ],
      [],
      { python: 'my-analysis', r: 'default-r' }
    )

    const input = container.querySelector(
      '[data-testid="kernel-terminal-input"]'
    ) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'print(1)' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(window.api.notebook.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'python'
      })
    )
    expect(window.api.notebook.execute).toHaveBeenCalledWith(
      expect.not.objectContaining({ environment: expect.anything() })
    )
  })

  it('shows the selector across two python envs, defaults labeled "default", and filters on selection', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python', script: 'print("default")' }),
      makeRun({
        runId: 'p2',
        kernelKind: 'python',
        script: 'print("analysis")',
        environment: 'my-analysis'
      })
    ])

    const selector = container.querySelector('[data-testid="env-selector"]') as HTMLElement
    expect(selector).not.toBeNull()

    const defaultOption = selector.querySelector(
      '[data-testid="env-option-default-python"]'
    ) as HTMLButtonElement
    const analysisOption = selector.querySelector(
      '[data-testid="env-option-my-analysis"]'
    ) as HTMLButtonElement
    expect(defaultOption.textContent).toContain('default')
    expect(analysisOption.textContent).toContain('my-analysis')

    // Default env selected initially (default-first ordering).
    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('print("default")')
    expect(container.textContent).not.toContain('print("analysis")')

    act(() => analysisOption.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('print("analysis")')
    expect(container.textContent).not.toContain('print("default")')
    expect(container.querySelector('[data-testid="kernel-terminal-input"]')).toBeNull()
    expect(container.querySelector('[data-testid="notebook-read-only-status"]')?.textContent).toBe(
      'my-analysis · history only; new code runs in default-python2 cells'
    )
  })

  it('groups a legacy run with no environment field under default-python', async () => {
    await mountWithRuns([
      makeRun({
        runId: 'p1',
        kernelKind: 'python',
        script: 'print("legacy")',
        environment: undefined
      }),
      makeRun({
        runId: 'p2',
        kernelKind: 'python',
        script: 'print("analysis")',
        environment: 'my-analysis'
      })
    ])

    const selector = container.querySelector('[data-testid="env-selector"]') as HTMLElement
    expect(selector.querySelector('[data-testid="env-option-default-python"]')).not.toBeNull()

    // Legacy run (no `environment`) is visible under the default-python option, selected by default.
    expect(container.textContent).toContain('print("legacy")')
    expect(container.textContent).not.toContain('print("analysis")')
  })

  it('shows a per-env status badge derived from state().environments', async () => {
    await mountWithRuns(
      [
        makeRun({ runId: 'p1', kernelKind: 'python', script: 'print(1)' }),
        makeRun({
          runId: 'p2',
          kernelKind: 'python',
          script: 'print(2)',
          environment: 'my-analysis'
        })
      ],
      [
        {
          processKey: 'python:default-python',
          kind: 'python',
          environment: 'default-python',
          status: 'idle'
        },
        {
          processKey: 'python:my-analysis',
          kind: 'python',
          environment: 'my-analysis',
          status: 'running'
        }
      ]
    )

    const analysisBadge = container.querySelector(
      '[data-testid="env-option-my-analysis-status"]'
    ) as HTMLElement
    expect(analysisBadge).not.toBeNull()
    expect(analysisBadge.className).toContain('bg-accent')
  })
})
