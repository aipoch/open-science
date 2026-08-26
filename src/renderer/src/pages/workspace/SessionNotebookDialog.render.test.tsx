import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'

import { SessionNotebookContent } from './SessionNotebookDialog'
import {
  createNotebookFrameFilterOptions,
  notebookFrameLabels,
  projectNotebookRunsForFrame
} from './session-notebook-projection'
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
  rootFrameId: 'root-frame-s1',
  agentFrameId: 'root-frame-s1',
  ...overrides
})

const renderContent = (props: {
  sessionId: string
  projectId?: string
  runs: NotebookRunRecord[]
  status: 'loading' | 'error' | 'ready'
  runCount?: number
  loadedRunCount?: number
  error?: string
  frameLabels?: Readonly<Record<string, string>>
}): string =>
  renderToStaticMarkup(
    <SessionNotebookContent
      onClose={vi.fn()}
      onExport={vi.fn()}
      onExportAll={vi.fn()}
      frameLabels={{ 'root-frame-s1': 'Main Agent' }}
      {...props}
    />
  )

describe('SessionNotebookContent', () => {
  it('shows the empty state when there are no runs', () => {
    const html = renderContent({ sessionId: '134d5d81aa', runs: [], status: 'ready' })

    expect(html).toContain('No execution records for this session.')
    expect(html).toContain('0 agents · 0 cells')
    expect(html).toContain('border-b border-border-300/90')
    expect(html).toContain('border-t border-border-300/90')
  })

  it('keeps Agent history discovery available when the recent window is empty', () => {
    const html = renderContent({
      sessionId: 's1',
      runs: [],
      runCount: 12,
      loadedRunCount: 0,
      status: 'ready',
      frameLabels: {
        'root-frame-s1': 'Main Agent',
        'frame-old': 'Older analysis'
      }
    })

    expect(html).not.toContain('No execution records for this session.')
    expect(html).toContain('aria-label="Filter notebook runs by Agent"')
    expect(html).toContain('Main Agent')
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

  it('keeps Session-wide Runs regardless of their Conversation Branch attribution', () => {
    const html = renderContent({
      sessionId: 's1',
      status: 'ready',
      runs: [
        makeRun({ runId: 'shared', script: 'print("shared")', messageBranchId: 'branch-parent' }),
        makeRun({ runId: 'old', script: 'print("old")', messageBranchId: 'branch-old' }),
        makeRun({ runId: 'new', script: 'print("new")', messageBranchId: 'branch-new' })
      ]
    })

    expect(html).toContain('1 agent · 3 cells')
    expect(html).toContain('print(&quot;shared&quot;)')
    expect(html).toContain('print(&quot;old&quot;)')
    expect(html).toContain('print(&quot;new&quot;)')
  })

  it('explains when the dialog loads only the recent run window', () => {
    const html = renderContent({
      sessionId: 's1',
      runs: [makeRun()],
      runCount: 125,
      loadedRunCount: 100,
      status: 'ready'
    })

    expect(html).toContain('Loaded 100 of 125 runs. Scroll up to load earlier history.')
  })

  it('renders timeout as a neutral limit instead of an error', () => {
    const html = renderContent({
      sessionId: 's1',
      status: 'ready',
      runs: [
        makeRun({
          status: 'timeout',
          text: { stdout: '', stderr: 'limit', traceback: '', plain: [] }
        })
      ]
    })

    expect(html).toContain('limit reached')
    expect(html).not.toContain('>error<')
    expect(html).not.toContain('text-danger-000')
  })

  it('shows exact registered input Versions inside the run that used them', () => {
    const html = renderContent({
      projectId: 'project-1',
      sessionId: 's1',
      status: 'ready',
      runs: [
        makeRun({
          inputFiles: [
            {
              inputFileVersionId: 'upload-version-1',
              sourceKind: 'upload-version',
              sourceFileId: 'upload-1',
              sourceVersionNumber: 1,
              sourceProjectId: 'project-1',
              sourceSessionId: 'source-session',
              filename: 'groups.csv',
              contentType: 'text/csv',
              sizeBytes: 42,
              checksum: 'a'.repeat(64),
              storageKey: 'internal-only',
              association: 'turn-attached'
            }
          ]
        })
      ]
    })

    expect(html).toContain('Input data')
    expect(html).toContain('groups.csv')
    expect(html).toContain('v1')
    expect(html).not.toContain('internal-only')
    expect(html.indexOf('data-testid="session-notebook-cell"')).toBeLessThan(
      html.indexOf('data-testid="notebook-input-data"')
    )
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

describe('Session Notebook producer projection', () => {
  const attributedRuns = [
    makeRun({
      runId: 'root-run',
      startedAt: 1,
      rootFrameId: 'root-frame-s1',
      agentFrameId: 'root-frame-s1'
    }),
    makeRun({ runId: 'child-two-run', startedAt: 2, agentFrameId: 'frame-two' }),
    makeRun({
      runId: 'legacy-run',
      startedAt: 3,
      rootFrameId: undefined,
      agentFrameId: undefined
    }),
    makeRun({ runId: 'child-one-run', startedAt: 4, agentFrameId: 'frame-one' })
  ]

  it('names only the Main Agent and delegated Subagents from the Session graph', () => {
    expect(
      notebookFrameLabels(
        {
          conversationGraph: {
            rootFrameId: 'root-frame-s1',
            frames: [
              { id: 'root-frame-s1', kind: 'root' },
              { id: 'frame-one', kind: 'delegate', delegateName: 'Evidence check' },
              { id: 'review-frame', kind: 'review', agentName: 'Reviewer' }
            ]
          }
        } as never,
        // Pinned to English so the copy assertion below stays readable.
        i18next.getFixedT('en')
      )
    ).toEqual({
      'root-frame-s1': 'Main Agent',
      'frame-one': 'Evidence check'
    })
  })

  it('derives named Main Agent and Subagent producers without All or Unattributed', () => {
    expect(
      createNotebookFrameFilterOptions(attributedRuns, {
        'root-frame-s1': 'Main agent',
        'frame-one': 'Evidence check',
        'frame-two': 'Sensitivity check',
        'frame-old': 'Older analysis'
      })
    ).toEqual([
      { value: 'frame:root-frame-s1', label: 'Main agent', count: 1 },
      { value: 'frame:frame-one', label: 'Evidence check', count: 1 },
      { value: 'frame:frame-two', label: 'Sensitivity check', count: 1 }
    ])
    expect(
      createNotebookFrameFilterOptions(
        attributedRuns,
        {
          'root-frame-s1': 'Main agent',
          'frame-one': 'Evidence check',
          'frame-two': 'Sensitivity check',
          'frame-old': 'Older analysis'
        },
        new Map(),
        true
      )
    ).toEqual([
      { value: 'frame:root-frame-s1', label: 'Main agent', count: 1 },
      { value: 'frame:frame-one', label: 'Evidence check', count: 1 },
      { value: 'frame:frame-two', label: 'Sensitivity check', count: 1 },
      { value: 'frame:frame-old', label: 'Older analysis' }
    ])
    expect(
      createNotebookFrameFilterOptions(
        attributedRuns,
        { 'frame-old': 'Older analysis' },
        new Map([
          [
            'frame-old',
            {
              agentFrameId: 'frame-old',
              runCount: 12,
              kernelCounts: { python: 0, r: 12, repl: 0, bash: 0 },
              latestDataKernel: 'r' as const
            }
          ]
        ])
      )
    ).toEqual([{ value: 'frame:frame-old', label: 'Older analysis', count: 12 }])
    expect(
      projectNotebookRunsForFrame(attributedRuns, 'frame:frame-two').map((run) => run.runId)
    ).toEqual(['child-two-run'])
  })

  it('does not expose raw Frame IDs when producer names are unavailable', () => {
    expect(createNotebookFrameFilterOptions(attributedRuns)).toEqual([])

    const html = renderContent({ sessionId: 's1', runs: [], status: 'ready' })
    expect(html).toContain('No execution records for this session.')
    expect(html).not.toContain('aria-label="Filter notebook runs by Agent"')
  })

  it('renders a named Agent filter that remains usable at narrow widths', () => {
    const html = renderContent({
      sessionId: 's1',
      runs: attributedRuns,
      status: 'ready',
      frameLabels: {
        'root-frame-s1': 'Main Agent',
        'frame-one': 'Evidence check',
        'frame-two': 'Sensitivity check'
      }
    })

    expect(html).toContain('aria-label="Filter notebook runs by Agent"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('title="Main Agent"')
    expect(html).not.toContain('<option')
    expect(html).not.toContain('>All ·')
    expect(html).not.toContain('Unattributed')
    expect(html).not.toContain('>frame-one ·')
    expect(html).toContain('max-w-full')
    expect(html).toContain('focus-visible:ring-3')
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
    expect(html.match(/focus-visible:ring-\[3px\]/g)).toHaveLength(3)
    expect(html).toContain('focus-visible:ring-3')
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
