// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { ProvisionStatus } from '../../../../shared/notebook-env'
import { createInitialNotebookEnvState, useNotebookEnvStore } from '../../stores/notebook-env-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '../../stores/preview-workbench-store'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
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

vi.mock('./notebook-code', () => ({
  NotebookCodeBlock: (props: { code: string }) => (
    <pre data-testid="notebook-code-block">{props.code}</pre>
  )
}))

const item: NotebookPreviewItem = {
  id: 'tool:session-1:notebook',
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

const readyStatus: ProvisionStatus = {
  pythonReady: true,
  rReady: false,
  version: 1,
  provisioning: false
}

const notebookState = (runs: NotebookRunRecord[]): Record<string, unknown> => ({
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
  environments: []
})

const setScrollGeometry = (
  element: HTMLElement,
  geometry: { clientHeight: number; scrollHeight: number; scrollTop: number }
): void => {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: geometry.clientHeight },
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
    scrollTop: { configurable: true, writable: true, value: geometry.scrollTop }
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useNotebookEnvStore.setState({
    ...createInitialNotebookEnvState(),
    status: readyStatus,
    ui: deriveProvisionUi(readyStatus, undefined, undefined, undefined)
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  useSessionStore.setState({
    ...createInitialSessionState(),
    selectedSessionId: 'session-1',
    sessions: [
      { id: 'session-1', conversationGraph: { rootFrameId: 'root-frame-session-1', frames: [] } }
    ]
  } as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const flushLoad = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('NotebookPreview follow-bottom', () => {
  it('keeps the current Session cells pinned to new output and pauses after the user scrolls up', async () => {
    let runs = [makeRun({ runId: 'p1', script: 'print(1)' })]
    let notifyChanged: (sessionId: string) => void = () => undefined

    window.api = {
      notebook: {
        state: vi.fn(() => Promise.resolve(notebookState(runs))),
        onChanged: vi.fn((listener: (event: { sessionId: string }) => void) => {
          notifyChanged = (sessionId) => listener({ sessionId })
          return (): void => undefined
        })
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
    await flushLoad()

    const cells = container.querySelector<HTMLElement>('[data-testid="notebook-cells"]')
    expect(cells).not.toBeNull()
    setScrollGeometry(cells as HTMLElement, { clientHeight: 400, scrollHeight: 1000, scrollTop: 0 })
    await act(async () => {
      root.render(<NotebookPreview item={item} />)
    })
    expect(cells?.scrollTop).toBe(600)

    runs = [
      makeRun({ runId: 'p1', script: 'print(1)' }),
      makeRun({ runId: 'p2', script: 'print(2)' })
    ]
    setScrollGeometry(cells as HTMLElement, {
      clientHeight: 400,
      scrollHeight: 1600,
      scrollTop: 600
    })
    await act(async () => {
      notifyChanged('session-1')
      await Promise.resolve()
    })
    await flushLoad()
    expect(cells?.scrollTop).toBe(1200)

    cells!.scrollTop = 80
    await act(async () => {
      cells?.dispatchEvent(new Event('scroll'))
    })
    runs = [...runs, makeRun({ runId: 'p3', script: 'print(3)' })]
    setScrollGeometry(cells as HTMLElement, {
      clientHeight: 400,
      scrollHeight: 2200,
      scrollTop: 80
    })
    await act(async () => {
      notifyChanged('session-1')
      await Promise.resolve()
    })
    await flushLoad()
    expect(cells?.scrollTop).toBe(80)
  })

  it('does not follow while another Session is selected', async () => {
    useSessionStore.setState({ selectedSessionId: 'session-2' } as never)
    let runs = [makeRun({ runId: 'p1' })]
    window.api = {
      notebook: {
        state: vi.fn(() => Promise.resolve(notebookState(runs))),
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
    await flushLoad()

    const cells = container.querySelector<HTMLElement>('[data-testid="notebook-cells"]')
    setScrollGeometry(cells as HTMLElement, {
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 40
    })
    await act(async () => {
      root.render(<NotebookPreview item={item} />)
    })
    expect(cells?.scrollTop).toBe(40)

    runs = [makeRun({ runId: 'p1' }), makeRun({ runId: 'p2' })]
    setScrollGeometry(cells as HTMLElement, {
      clientHeight: 400,
      scrollHeight: 1600,
      scrollTop: 40
    })
    await act(async () => {
      root.render(<NotebookPreview item={item} />)
    })
    expect(cells?.scrollTop).toBe(40)
  })
})
