import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../../../shared/notebook'
import { NotebookRunCell } from './NotebookPreview'

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'r1',
  cellId: 'c1',
  source: 'user',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'imported',
  startedAt: 0,
  executionCount: 1,
  text: { stdout: '1\n', stderr: '', traceback: '', plain: ['1\n'] },
  outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

describe('NotebookRunCell imported badge', () => {
  it('renders the imported badge beside the you badge for source snapshots', () => {
    const html = renderToStaticMarkup(<NotebookRunCell run={makeRun()} index={0} />)

    expect(html).toContain('>you<')
    expect(html).toContain('data-testid="notebook-imported-badge"')
    expect(html).toContain(
      'title="Snapshot from the source .ipynb — re-running appends a new run"'
    )
    expect(html).not.toContain('error (line')
  })
})
