// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../../../shared/notebook'
import { SessionNotebookContent } from './SessionNotebookDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  workingFiles: []
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
  vi.restoreAllMocks()
})

describe('SessionNotebookContent export', () => {
  it('invokes the export callback with the active tab kernel', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
          onImport={vi.fn()}
          onOpenJupyterLab={vi.fn()}
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
    expect(onExport).toHaveBeenCalledWith('python')
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
          runs={mixedRuns}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
          onImport={vi.fn()}
          onOpenJupyterLab={vi.fn()}
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

    expect(onExport).toHaveBeenCalledWith('r')
  })

  it('surfaces export failures and re-enables the button', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('Disk is full'))
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
          onImport={vi.fn()}
          onOpenJupyterLab={vi.fn()}
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
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
          onExportAll={vi.fn()}
          onImport={vi.fn()}
          onOpenJupyterLab={vi.fn()}
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
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={failingExport}
          onExportAll={vi.fn()}
          onImport={vi.fn()}
          onOpenJupyterLab={vi.fn()}
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
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={vi.fn()}
          onImport={vi.fn()}
          onOpenJupyterLab={vi.fn()}
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
          runs={mixedRuns}
          status="ready"
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={onExportAll}
          onImport={vi.fn()}
          onOpenJupyterLab={vi.fn()}
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
  })

  it('hides the "Download all" button when only one data kernel has runs', async () => {
    const onExportAll = vi.fn()
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={onExportAll}
          onImport={vi.fn()}
          onOpenJupyterLab={vi.fn()}
        />
      )
    })

    const allButton = container.querySelector<HTMLButtonElement>(
      'button[data-testid="session-notebook-export-all"]'
    )
    expect(allButton).toBeNull()
    expect(onExportAll).not.toHaveBeenCalled()
  })

  it('invokes import for an empty notebook and surfaces failures', async () => {
    const onImport = vi.fn().mockRejectedValue(new Error('Invalid notebook'))
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          runs={[]}
          status="ready"
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={vi.fn()}
          onImport={onImport}
          onOpenJupyterLab={vi.fn()}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Import .ipynb"]')
    expect(button?.disabled).toBe(false)
    await act(async () => {
      button?.click()
      await Promise.resolve()
    })

    expect(onImport).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Invalid notebook')
    expect(button?.disabled).toBe(false)
  })

  it('opens JupyterLab and surfaces launcher failures', async () => {
    const onOpenJupyterLab = vi.fn().mockRejectedValue(new Error('Install denied'))
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={vi.fn()}
          onExportAll={vi.fn()}
          onImport={vi.fn()}
          onOpenJupyterLab={onOpenJupyterLab}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open in JupyterLab"]'
    )
    expect(button?.disabled).toBe(false)
    await act(async () => {
      button?.click()
      await Promise.resolve()
    })

    expect(onOpenJupyterLab).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Install denied')
  })
})
