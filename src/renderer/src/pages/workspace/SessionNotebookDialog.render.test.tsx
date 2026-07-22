import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { SessionNotebookContent } from './SessionNotebookDialog'
import type { NotebookRunRecord } from '../../../../shared/notebook'

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'r1',
  cellId: 'c1',
  source: 'agent',
  kernelKind: 'python',
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
}): string =>
  renderToStaticMarkup(
    <SessionNotebookContent
      onClose={vi.fn()}
      onExport={vi.fn()}
      onExportAll={vi.fn()}
      {...props}
    />
  )

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

  it('enables .ipynb export for a loaded notebook and disables it when empty', () => {
    const populated = renderContent({
      sessionId: 's1',
      runs: [makeRun()],
      status: 'ready'
    })
    const empty = renderContent({ sessionId: 's1', runs: [], status: 'ready' })

    expect(populated).toContain('.ipynb')
    // Main button's aria-label now names the kernel it's downloading, so a python-only session
    // shows "Download python as .ipynb". The empty state should keep the button disabled.
    const populatedButton = populated.match(
      /<button[^>]*aria-label="Download python as \.ipynb"[^>]*>/
    )?.[0]
    const emptyButton = empty.match(
      /<button[^>]*aria-label="Download python as \.ipynb"[^>]*>/
    )?.[0]
    expect(populatedButton).not.toMatch(/\sdisabled(?:=|\s|>)/)
    expect(emptyButton).toMatch(/\sdisabled(?:=|\s|>)/)
  })

  it('hides the "Download all" button when the session has only one data kernel', () => {
    const pythonOnly = renderContent({
      sessionId: 's1',
      runs: [makeRun()],
      status: 'ready'
    })
    const mixed = renderContent({
      sessionId: 's1',
      runs: [makeRun(), makeRun({ runId: 'r1', kernelKind: 'r', environment: 'default-r' })],
      status: 'ready'
    })

    expect(pythonOnly).not.toContain('aria-label="Download separate notebooks by kernel')
    // Mixed sessions surface the secondary button with the count baked into the label.
    expect(mixed).toContain('aria-label="Download separate notebooks by kernel (2)"')
  })
})

describe('SessionNotebookContent per-kernel tabs', () => {
  it('renders a tab per present kind and shows the default (python) pane', () => {
    const pythonRun = makeRun({ runId: 'p1', kernelKind: 'python', script: 'print(1)' })
    const replRun = makeRun({ runId: 'x1', kernelKind: 'repl', script: 'await host.mcp()' })
    const bashRun = makeRun({ runId: 'b1', kernelKind: 'bash', script: 'ls -la' })

    const html = renderContent({
      sessionId: 's1',
      runs: [pythonRun, replRun, bashRun],
      status: 'ready'
    })

    // Cell count counts python/r runs only; repl/bash surface as extra counts.
    expect(html).toContain('1 agent · 1 cell')
    expect(html).toContain('1 repl / 1 shell')

    // A switcher tab per present kind (Agent SDK for repl, Bash for bash).
    expect(html).toContain('data-testid="session-notebook-tab-python"')
    expect(html).toContain('data-testid="session-notebook-tab-repl"')
    expect(html).toContain('data-testid="session-notebook-tab-bash"')
    expect(html).toContain('Agent SDK')
    expect(html).toContain('Bash')

    // Only the active (default python) pane renders; other kinds sit behind their tabs.
    expect(html).toContain('data-testid="session-notebook-kernel-python"')
    expect(html).not.toContain('data-testid="session-notebook-kernel-repl"')
    expect(html).not.toContain('data-testid="session-notebook-kernel-bash"')
    // The active python cell carries no origin label (repl/bash cells, which do, are behind tabs).
    expect(html).not.toContain('data-testid="session-notebook-cell-origin"')
  })

  it('shows no repl/bash tab for a python-only session', () => {
    const html = renderContent({
      sessionId: 's1',
      runs: [makeRun({ runId: 'p1' }), makeRun({ runId: 'p2' })],
      status: 'ready'
    })

    expect(html).toContain('1 agent · 2 cells')
    expect(html).toContain('data-testid="session-notebook-tab-python"')
    expect(html).not.toContain('data-testid="session-notebook-tab-repl"')
    expect(html).not.toContain('data-testid="session-notebook-tab-bash"')
  })
})
