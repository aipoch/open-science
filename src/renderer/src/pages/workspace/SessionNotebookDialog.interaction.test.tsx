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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SessionNotebookContent export', () => {
  it('invokes the export callback from the enabled .ipynb button', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <SessionNotebookContent
          sessionId="session-1"
          runs={[run]}
          status="ready"
          onClose={vi.fn()}
          onExport={onExport}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download as .ipynb"]'
    )
    expect(button?.disabled).toBe(false)

    await act(async () => {
      button?.click()
      await Promise.resolve()
    })

    expect(onExport).toHaveBeenCalledOnce()
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
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download as .ipynb"]'
    )
    await act(async () => {
      button?.click()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Disk is full')
    expect(button?.disabled).toBe(false)
  })
})
