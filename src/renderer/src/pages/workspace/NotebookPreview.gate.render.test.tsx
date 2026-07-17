// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookEnvironmentStatus, NotebookRunRecord } from '../../../../shared/notebook'
import type { ProvisionStatus } from '../../../../shared/notebook-env'
import { createInitialNotebookEnvState, useNotebookEnvStore } from '../../stores/notebook-env-store'
import { EnvProvisionOverlay } from './EnvProvisionOverlay'
import { NotebookPreview, type NotebookPreviewItem } from './NotebookPreview'
import { deriveProvisionUi } from './provisioning-view'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useNotebookEnvStore.setState(createInitialNotebookEnvState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('EnvProvisionOverlay', () => {
  it('shows the python preparation message and progress', () => {
    const ui = deriveProvisionUi(
      { pythonReady: false, rReady: false, version: 3, provisioning: true },
      'python',
      { phase: 'materialize', message: 'Preparing Python environment…', progress: 0.5 },
      undefined
    )
    act(() => root.render(<EnvProvisionOverlay ui={ui} />))
    const gate = container.querySelector('[data-testid="notebook-env-gate"]')
    expect(gate?.textContent).toContain('Preparing Python environment')
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
      projectName: 'proj',
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
      projectName: 'proj',
      workspaceCwd: '/tmp/proj',
      notebookSessionRoot: '/tmp/proj/.notebook',
      dataRoot: '/tmp/proj/.notebook/data',
      runtimeRoot: '/tmp/proj/.notebook/runtime',
      runJsonPath: '/tmp/proj/.notebook/run.json'
    }
  }

  const mountWithRuns = async (
    runs: NotebookRunRecord[],
    environments: NotebookEnvironmentStatus[] = []
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
            environments
          })
        ),
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

  it('shows a tab only for kernel kinds present in the runs (no default python/r tab)', async () => {
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
    // R produced no run here, so its tab does not appear (it shows up only once R is used).
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).toBeNull()
  })

  it('shows the R tab only once R has produced a run', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python' }),
      makeRun({ runId: 'r1', kernelKind: 'r', script: 'print(1)' })
    ])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).not.toBeNull()
  })

  it('shows no Agent SDK/Bash tab for a python-only run set', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python' }),
      makeRun({ runId: 'p2', kernelKind: 'python' })
    ])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
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

  it('defaults to the Agent SDK tab and shows no R tab when only repl runs exist', async () => {
    await mountWithRuns([
      makeRun({ runId: 'x1', kernelKind: 'repl', script: 'host.notebook.run(...)' })
    ])

    // No tab click: this is the pre-click default state. repl is the only kind with runs, so it is
    // the active tab; python and R have no runs, so neither tab is shown.
    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    const replTab = switcher.querySelector(
      '[data-testid="kernel-switcher-repl"]'
    ) as HTMLButtonElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-python"]')).toBeNull()
    expect(replTab.className).toContain('bg-bg-300')

    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('host.notebook.run')
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
      projectName: 'proj',
      workspaceCwd: '/tmp/proj',
      notebookSessionRoot: '/tmp/proj/.notebook',
      dataRoot: '/tmp/proj/.notebook/data',
      runtimeRoot: '/tmp/proj/.notebook/runtime',
      runJsonPath: '/tmp/proj/.notebook/run.json'
    }
  }

  const mountWithRuns = async (
    runs: NotebookRunRecord[],
    environments: NotebookEnvironmentStatus[] = []
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
            environments
          })
        ),
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
