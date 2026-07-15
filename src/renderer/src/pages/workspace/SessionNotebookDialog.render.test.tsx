import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { SessionNotebookContent } from './SessionNotebookDialog'
import type { NotebookRunRecord } from '../../../../shared/notebook'

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'r1',
  cellId: 'c1',
  source: 'agent',
  script: 'import os\nimport requests',
  status: 'completed',
  startedAt: 0,
  executionCount: 0,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

const renderContent = (props: {
  sessionId: string
  runs: NotebookRunRecord[]
  status: 'loading' | 'error' | 'ready'
  error?: string
}): string => renderToStaticMarkup(<SessionNotebookContent onClose={vi.fn()} {...props} />)

describe('SessionNotebookContent', () => {
  it('shows the empty state when there are no runs', () => {
    const html = renderContent({ sessionId: '134d5d81aa', runs: [], status: 'ready' })

    expect(html).toContain('No execution records for this session.')
    expect(html).toContain('0 agents · 0 cells')
  })

  it('renders one cell per run with a derived error badge and split output', () => {
    const failing = makeRun({
      status: 'failed',
      executionCount: 0,
      text: {
        stdout: 'OPENALEX_API_KEY present: False',
        stderr: '',
        traceback: 'File "<cell>", line 2, in <module>\nModuleNotFoundError',
        plain: []
      }
    })
    const html = renderContent({ sessionId: 's1', runs: [failing], status: 'ready' })

    expect(html).toContain('1 agent · 1 cell')
    expect(html).toContain('error (line 2)')
    expect(html).toContain('OPENALEX_API_KEY present: False')
    expect(html).toContain('ModuleNotFoundError')
  })

  it('renders the .ipynb footer button as disabled', () => {
    const html = renderContent({ sessionId: 's1', runs: [], status: 'ready' })

    expect(html).toContain('.ipynb')
    // The only disabled control in the content is the placeholder export button.
    expect(html).toContain('disabled')
  })
})
