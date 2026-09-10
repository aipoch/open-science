// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionNotebookContent } from '@/pages/workspace/SessionNotebookDialog'
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('Notebook kernel tabs move focus with ArrowRight', async () => {
  const base = {
    cellId: 'c',
    source: 'agent',
    script: '1',
    status: 'completed',
    startedAt: 1,
    executionCount: 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    rootFrameId: 'root',
    agentFrameId: 'root'
  }
  await act(async () => {
    render(
      <SessionNotebookContent
        sessionId="s"
        frameLabels={{ root: 'Main Agent' }}
        runs={
          [
            { ...base, runId: 'py', kernelKind: 'python' },
            { ...base, runId: 'r', kernelKind: 'r' }
          ] as ComponentProps<typeof SessionNotebookContent>['runs']
        }
        status="ready"
        onClose={vi.fn()}
        onExport={vi.fn()}
        onExportAll={vi.fn()}
      />
    )
  })
  const tabs = screen.getAllByRole('tab')
  expect(tabs.length).toBeGreaterThan(1)
  act(() => tabs[0].focus())
  fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
  await waitFor(() => expect(document.activeElement).toBe(tabs[1]))
})
