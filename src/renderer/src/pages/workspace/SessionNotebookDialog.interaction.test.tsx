// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../../../shared/notebook'
import { SessionNotebookDialog, SessionNotebookContent } from './SessionNotebookDialog'
import type { ChatSession } from '@/stores/session-store'
import type { NotebookChangedEvent, NotebookSessionStateRequest } from '../../../../shared/notebook'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

const run: NotebookRunRecord = {
  runId: 'run-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print("hello")',
  status: 'completed',
  startedAt: 1,
  executionCount: 1,
  text: { stdout: 'hello', stderr: '', traceback: '', plain: ['hello'] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  rootFrameId: 'root-frame-session-1',
  agentFrameId: 'root-frame-session-1'
}

const frameLabels = {
  'root-frame-session-1': 'Main Agent',
  'frame-child': 'Evidence check'
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SessionNotebookContent export', () => {
  it('loads the previous page when the near-top sentinel intersects', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    const onLoadEarlier = vi.fn()
    const viewportRef = createRef<HTMLDivElement>()
    const topSentinelRef = createRef<HTMLDivElement>()

    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={[run]}
          runCount={2}
          status="ready"
          historyPage={{
            hasEarlierRuns: true,
            oldestCursor: { startedAt: 1, runId: 'run-1' }
          }}
          viewportRef={viewportRef}
          topSentinelRef={topSentinelRef}
          onLoadEarlier={onLoadEarlier}
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={vi.fn()}
        />
      )
    })

    expect(intersectionCallback).toBeTypeOf('function')
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(onLoadEarlier).toHaveBeenCalledOnce()
  })

  it('falls back to a manual earlier-page control without IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const onLoadEarlier = vi.fn()
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={[run]}
          runCount={2}
          status="ready"
          historyPage={{
            hasEarlierRuns: true,
            oldestCursor: { startedAt: 1, runId: 'run-1' }
          }}
          viewportRef={createRef<HTMLDivElement>()}
          topSentinelRef={createRef<HTMLDivElement>()}
          onLoadEarlier={onLoadEarlier}
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={vi.fn()}
        />
      )
    })

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Load earlier runs'
    )
    await act(async () => button?.click())
    expect(onLoadEarlier).toHaveBeenCalledOnce()
  })

  it('discovers and exports a kernel that exists only outside the recent window', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    const onLoadHistorySummary = vi.fn(async (agentFrameId: string) =>
      agentFrameId === 'frame-child'
        ? {
            agentFrameId,
            runCount: 12,
            kernelCounts: { python: 0, r: 12, repl: 0, bash: 0 },
            latestDataKernel: 'r' as const
          }
        : {
            agentFrameId,
            runCount: 1,
            kernelCounts: { python: 1, r: 0, repl: 0, bash: 0 },
            latestDataKernel: 'python' as const
          }
    )
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={[run]}
          status="ready"
          onLoadHistorySummary={onLoadHistorySummary}
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    const filter = container.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Filter notebook runs by Agent"]'
    )
    await act(async () => {
      if (filter) fireEvent.click(filter)
    })
    const childOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('Evidence check')
    )
    await act(async () => {
      if (childOption) fireEvent.click(childOption)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onLoadHistorySummary).toHaveBeenCalledWith('frame-child')
    expect(container.querySelector('[data-testid="session-notebook-tab-r"]')).not.toBeNull()
    expect(container.textContent).toContain(
      'No runs from this kernel are in the recent window. Downloads include the complete history.'
    )
    const exportButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download r as .ipynb"]'
    )
    expect(exportButton?.disabled).toBe(false)
    await act(async () => {
      exportButton?.click()
      await Promise.resolve()
    })
    expect(onExport).toHaveBeenCalledWith('r', 'frame-child')
  })

  it('filters the visible projection by producer Frame without mutating the Run set', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    const runs = [
      { ...run, runId: 'root-run', script: 'print("root")', agentFrameId: 'root-frame-session-1' },
      { ...run, runId: 'child-run', script: 'print("child")', agentFrameId: 'frame-child' },
      {
        ...run,
        runId: 'legacy-run',
        script: 'print("legacy")',
        rootFrameId: undefined,
        agentFrameId: undefined
      }
    ]
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={runs}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
        />
      )
    })

    const filter = container.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Filter notebook runs by Agent"]'
    )
    expect(filter?.textContent).toContain('Main Agent · 1 run')
    expect(container.textContent).toContain('print("root")')
    expect(container.textContent).not.toContain('print("child")')

    await act(async () => {
      if (filter) fireEvent.click(filter)
    })
    const childOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('Evidence check · 1 run')
    )
    await act(async () => {
      if (childOption) fireEvent.click(childOption)
    })

    expect(container.textContent).not.toContain('print("root")')
    expect(container.textContent).toContain('print("child")')
    expect(container.textContent).not.toContain('print("legacy")')
    expect(runs).toHaveLength(3)

    const exportButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download python as .ipynb"]'
    )
    await act(async () => {
      exportButton?.click()
      await Promise.resolve()
    })
    expect(onExport).toHaveBeenCalledWith('python', 'frame-child')
  })

  it('invokes the export callback with the active tab kernel', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download python as .ipynb"]'
    )
    expect(button?.disabled).toBe(false)

    await act(async () => {
      button?.click()
      await Promise.resolve()
    })

    // The active tab defaults to python; the callback receives the kernel that names the file.
    expect(onExport).toHaveBeenCalledOnce()
    expect(onExport).toHaveBeenCalledWith('python', 'root-frame-session-1')
  })

  it('passes the clicked tab kernel to the export callback after switching tabs', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    const mixedRuns: NotebookRunRecord[] = [
      run,
      { ...run, runId: 'r1', kernelKind: 'r', environment: 'default-r' }
    ]
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={mixedRuns}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
        />
      )
    })

    // Click the R tab before exporting so the callback sees the new activeKind.
    const rTab = container.querySelector<HTMLButtonElement>(
      'button[data-testid="session-notebook-tab-r"]'
    )
    await act(async () => {
      rTab?.click()
      await Promise.resolve()
    })

    const exportButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download r as .ipynb"]'
    )
    expect(exportButton).not.toBeNull()
    await act(async () => {
      exportButton?.click()
      await Promise.resolve()
    })

    expect(onExport).toHaveBeenCalledWith('r', 'root-frame-session-1')
  })

  it('surfaces export failures and re-enables the button', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('Disk is full'))
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download python as .ipynb"]'
    )
    await act(async () => {
      button?.click()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Disk is full')
    expect(button?.disabled).toBe(false)
  })

  it('logs export failures for diagnostics, not just the footer banner', async () => {
    const failure = new Error('Disk is full')
    const onExport = vi.fn().mockRejectedValue(failure)
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
        />
      )
    })

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Download python as .ipynb"]')
        ?.click()
      await Promise.resolve()
    })

    expect(console.error).toHaveBeenCalledWith('Failed to export notebook as .ipynb:', failure)
  })

  it('discards a failed export state when the content remounts for another session', async () => {
    const failingExport = vi.fn().mockRejectedValue(new Error('Disk is full'))
    await act(async () => {
      root.render(
        <SessionNotebookContent
          key="session-a"
          sessionId="session-a"
          frameLabels={frameLabels}
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={failingExport}
          onExportAll={vi.fn()}
        />
      )
    })

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Download python as .ipynb"]')
        ?.click()
      await Promise.resolve()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Disk is full')

    // The container remounts SessionNotebookContent with key={session.id} on session switch.
    await act(async () => {
      root.render(
        <SessionNotebookContent
          key="session-b"
          sessionId="session-b"
          frameLabels={frameLabels}
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[role="alert"], [role="status"]')?.textContent).toBe('')
  })

  it('invokes onExportAll for the "Download all" button on mixed sessions', async () => {
    const onExportAll = vi.fn().mockResolvedValue(undefined)
    const mixedRuns: NotebookRunRecord[] = [
      run,
      { ...run, runId: 'r1', kernelKind: 'r', environment: 'default-r' }
    ]
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={mixedRuns}
          status="ready"
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={onExportAll}
        />
      )
    })

    const allButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download separate notebooks by kernel (2)"]'
    )
    expect(allButton).not.toBeNull()
    await act(async () => {
      allButton?.click()
      await Promise.resolve()
    })

    expect(onExportAll).toHaveBeenCalledOnce()
    expect(onExportAll).toHaveBeenCalledWith('root-frame-session-1')
  })

  it('hides the "Download all" button when only one data kernel has runs', async () => {
    const onExportAll = vi.fn()
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          frameLabels={frameLabels}
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={onExportAll}
        />
      )
    })

    const allButton = container.querySelector<HTMLButtonElement>(
      'button[data-testid="session-notebook-export-all"]'
    )
    expect(allButton).toBeNull()
    expect(onExportAll).not.toHaveBeenCalled()
  })
})

describe('bounded history container', () => {
  it('returns to evicted latest runs, refreshes new/deleted runs, and rejects an old session page', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    let changed: ((event: NotebookChangedEvent) => void) | undefined
    let records = Array.from({ length: 300 }, (_, index) => ({
      ...run,
      runId: `history-${index}`,
      cellId: `history-cell-${index}`,
      startedAt: index,
      script: `value_${index} = 1`
    }))
    records[250] = { ...records[250], kernelKind: 'r' }
    let pendingEarlier: ((value: unknown) => void) | undefined
    let deferEarlier = false
    const state = vi.fn(async (request: NotebookSessionStateRequest) => {
      if (request.historySummaryFrameId) return { runs: [], runCount: records.length }
      if (request.projectId === 'other-project')
        return {
          runs: [{ ...run, runId: 'other', script: 'other_session_value' }],
          runCount: 1,
          historyPage: { hasEarlierRuns: false }
        }
      const eligible = records.filter(
        (record) => !request.historyBefore || record.startedAt < request.historyBefore.startedAt
      )
      const page = eligible.slice(-100)
      const response = {
        runs: page,
        runCount: records.length,
        historyPage: {
          hasEarlierRuns: eligible.length > page.length,
          oldestCursor: { startedAt: page[0].startedAt, runId: page[0].runId }
        }
      }
      if (deferEarlier && request.historyBefore)
        return new Promise((resolve) => {
          pendingEarlier = resolve
        })
      return response
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        notebook: {
          state,
          getReference: vi.fn(async () => ({})),
          onChanged: (callback: typeof changed) => {
            changed = callback
            return () => {
              changed = undefined
            }
          }
        }
      }
    })
    const session = {
      id: 'bounded-history-container',
      projectId: 'p',
      cwd: '/workspace',
      messages: [],
      activities: [],
      conversationGraph: {
        rootFrameId: 'root-frame-session-1',
        frames: [{ id: 'root-frame-session-1', kind: 'root' }]
      }
    } as unknown as ChatSession
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    }
    const click = async (label: string): Promise<void> => {
      const button = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === label
      )
      expect(button, label + document.body.textContent).toBeTruthy()
      await act(async () => button!.click())
      await settle()
    }
    await act(async () =>
      root.render(<SessionNotebookDialog session={session} onClose={vi.fn()} />)
    )
    await settle()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="session-notebook-tab-r"]')!.click()
    )
    expect(document.body.textContent).toContain('value_250')
    await click('Load earlier runs')
    await click('Load earlier runs')
    expect(document.querySelectorAll('[data-testid="session-notebook-cell"]')).toHaveLength(200)
    expect(document.body.textContent).not.toContain('value_299')
    expect(document.body.textContent).not.toContain('Scroll up to load earlier history.')
    await click('Return to latest runs')
    expect(document.body.textContent).toContain('value_250')
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="session-notebook-tab-python"]')!
        .click()
    )
    expect(document.querySelectorAll('[data-testid="session-notebook-cell"]')).toHaveLength(99)
    expect(document.body.textContent).toContain('value_299')
    // A new run and deletion invalidate all cached pages and keep the displayed window bounded.
    records = records.filter((record) => record.runId !== 'history-299')
    records.push({
      ...run,
      runId: 'new-run',
      cellId: 'new-cell',
      startedAt: 301,
      script: 'new_live_value'
    })
    await act(async () =>
      changed?.({ projectId: 'p', sessionId: session.id } as NotebookChangedEvent)
    )
    await settle()
    expect(document.body.textContent).toContain('new_live_value')
    expect(document.body.textContent).not.toContain('value_299')
    deferEarlier = true
    await click('Load earlier runs')
    expect(pendingEarlier).toBeTypeOf('function')
    await act(async () =>
      root.render(
        <SessionNotebookDialog
          session={{ ...session, projectId: 'other-project' }}
          onClose={vi.fn()}
        />
      )
    )
    await settle()
    await act(async () =>
      pendingEarlier?.({
        runs: records.slice(0, 100),
        runCount: 300,
        historyPage: { hasEarlierRuns: false }
      })
    )
    expect(document.body.textContent).toContain('other_session_value')
    expect(document.body.textContent).not.toContain('value_0')
    expect(state.mock.calls.every(([request]) => request.readMode === 'bounded')).toBe(true)
  })
})
