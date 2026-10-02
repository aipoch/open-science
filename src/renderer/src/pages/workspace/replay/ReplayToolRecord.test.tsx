import { ReplayReviewRecord } from './ReplayReviewRecord'
import type { ReviewWithChecks } from '../../../../../shared/reviewer'
// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedToolActivity } from '../../../../../shared/session-persistence'
import type { NotebookRunRecord } from '../../../../../shared/notebook'
import type { ReplayStep } from '../../../../../shared/replay'
import { ReplayActivityGroup, ReplayToolRecord } from './ReplayToolRecord'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const activity: PersistedToolActivity = {
  id: 'tool',
  kind: 'tool',
  title: 'Run archived analysis',
  status: 'failed',
  sortIndex: 0,
  eventIds: [],
  createdAt: 0,
  updatedAt: 1000,
  rawInput: { command: 'analyze saved-data.csv' },
  terminalOutput: 'terminal channel',
  rawOutput: { reason: 'result channel' },
  toolContent: [{ type: 'text', text: 'content channel' }],
  terminalExitCode: 7,
  toolDisposition: 'declined',
  elicitation: {
    message: 'Which archived dataset?',
    state: 'answered',
    fields: [{ id: 'dataset', kind: 'text', label: 'Dataset' }],
    answers: [{ fieldId: 'dataset', value: 'saved-data.csv' }]
  }
}
describe('read-only saved tool interactions', () => {
  it('shows each saved output channel, confirmation answer, decision and exit code after the result boundary', () => {
    const { container, rerender } = render(
      <ReplayToolRecord activity={activity} showResults={false} />
    )
    expect(screen.getByText(/Which archived dataset/u)).toBeTruthy()
    expect(container.textContent).not.toContain('terminal channel')
    expect(container.textContent).not.toContain('Request declined')
    expect(screen.queryByText('Recorded answers')).toBeNull()
    rerender(<ReplayToolRecord activity={activity} showResults />)
    expect(container.querySelectorAll('[data-replay-output-channel]')).toHaveLength(3)
    for (const text of [
      'terminal channel',
      'result channel',
      'content channel',
      'Recorded answers',
      'Request declined',
      'Exit code'
    ])
      expect(container.textContent).toContain(text)
    expect(container.textContent).toContain('7')
    expect(container.querySelectorAll('button,input,select')).toHaveLength(0)
  })
  it('bounds large archived payloads and explicitly offers the full original record', () => {
    const { container } = render(
      <ReplayToolRecord
        activity={{
          ...activity,
          rawInput: 'oversized input '.repeat(100000),
          terminalOutput: 'oversized output '.repeat(100000)
        }}
        showResults
      />
    )
    expect(container.textContent!.length).toBeLessThan(40000)
    expect(
      screen.getAllByText('Preview is truncated. Open the evidence for the complete record.')
    ).toHaveLength(2)
  })
})

describe('workspace-style archived tool rows', () => {
  it.each([
    'mcp__open-science-artifacts__write_artifact_file',
    'mcp__open_science_artifacts__write_artifact_file',
    'mcp.open-science-artifacts.write_artifact_file',
    'write_artifact_file'
  ])(
    'summarizes an artifact without exposing its transport payload: %s',
    async (providerToolName) => {
      const receipt = JSON.stringify({
        artifact: {
          artifact_id: 'internal-artifact-id',
          version_id: 'internal-version',
          filename: 'sin_plot_r.png',
          size_bytes: 50544
        }
      })
      const archived = {
        ...activity,
        status: 'completed' as const,
        providerToolName,
        rawInput: { filename: 'sin_plot_r.png' },
        rawOutput: [{ type: 'text', text: receipt }],
        toolContent: [
          { type: 'content' as const, content: { type: 'text' as const, text: receipt } }
        ],
        elicitation: undefined,
        toolDisposition: undefined
      }
      const { container, rerender } = render(
        <ReplayToolRecord activity={archived} showResults={false} interactive />
      )
      fireEvent.click(screen.getByTestId('tool-chip'))
      await waitFor(() => expect(screen.getByTestId('tool-summary-card')).toBeTruthy())
      expect(container.textContent).not.toContain('49 KB')
      expect(container.textContent).not.toContain('internal-version')
      rerender(<ReplayToolRecord activity={archived} showResults interactive />)
      await waitFor(() => expect(screen.getByText('Size')).toBeTruthy())
      expect(container.textContent).toContain('sin_plot_r.png')
      expect(container.textContent).not.toContain('internal-artifact-id')
      expect(screen.queryByText('Original recorded evidence')).toBeNull()
      rerender(<ReplayToolRecord activity={archived} showResults={false} interactive />)
      expect(container.textContent).not.toContain('internal-artifact-id')
      expect(archived.rawOutput).toEqual([{ type: 'text', text: receipt }])
    }
  )
  it('keeps native Skill activity styling without resolving a live skill document', () => {
    const { container } = render(
      <ReplayToolRecord
        activity={{
          ...activity,
          title: 'Load skill: mcp-pubmed',
          providerToolName: 'Skill',
          status: 'completed',
          elicitation: undefined,
          toolDisposition: undefined,
          rawOutput: undefined,
          toolContent: undefined
        }}
        showResults
        interactive
      />
    )
    expect(screen.getByTestId('tool-chip').textContent).toContain('Loaded skill: mcp-pubmed')
    expect(screen.getByTestId('tool-chip').textContent).toContain('mcp-pubmed')
    expect(screen.getByTestId('tool-chip').querySelector('svg')).toBeTruthy()
    expect(container.querySelector('button')).toBeNull()
  })
  it('keeps unknown results and confirmation answers in the dedicated evidence renderer', async () => {
    const { container, rerender } = render(
      <ReplayToolRecord activity={activity} showResults interactive />
    )
    expect(container.textContent).not.toContain('result channel')
    expect(container.textContent).not.toContain('content channel')
    expect(container.querySelectorAll('input,select')).toHaveLength(0)
    expect(screen.queryByText('Original recorded evidence')).toBeNull()
    rerender(<ReplayToolRecord activity={activity} showResults />)
    await waitFor(() => expect(container.textContent).toContain('terminal channel'))
    expect(container.textContent).toContain('Recorded answers')
  })
})

it('keeps prefetched Notebook figures behind the result boundary and shares group collapse', async () => {
  const run: NotebookRunRecord = {
    runId: 'plot-run',
    cellId: 'plot-cell',
    source: 'agent',
    kernelKind: 'r',
    script: 'plot(1:3)',
    status: 'completed',
    startedAt: 1,
    endedAt: 2,
    executionInvocationId: 'plot-invocation',
    text: { stdout: 'Plot saved.', stderr: '', traceback: '', plain: [] },
    outputs: [{ type: 'display', data: { 'image/png': 'aW1hZ2U=' } }],
    workingFiles: [],
    artifacts: []
  }
  const step: ReplayStep = {
    id: 'plot-step',
    branchId: 'main',
    kind: 'notebook',
    startMs: 0,
    endMs: 1000,
    durationMs: 1000,
    recordedAt: 1,
    recordedEndAt: 2,
    runs: [run],
    resourceIds: [],
    evidence: [],
    issues: [],
    activities: [
      {
        ...activity,
        status: 'completed',
        elicitation: undefined,
        toolDisposition: undefined,
        providerToolName: 'mcp__open-science-notebook__notebook_execute',
        executionInvocationId: 'plot-invocation',
        rawInput: { code: 'plot(1:3)', kernelKind: 'r' },
        rawOutput: { runId: 'plot-run', status: 'completed' },
        toolContent: []
      }
    ]
  }
  const runDetails = { 'plot-run': { status: 'ready' as const, run, bytes: 100 } }
  const { rerender } = render(
    <ReplayActivityGroup step={step} showResults={false} runDetails={runDetails} />
  )
  expect(screen.queryByTestId('notebook-tool-figure-outputs')).toBeNull()
  rerender(<ReplayActivityGroup step={step} showResults runDetails={runDetails} />)
  expect(screen.getByTestId('notebook-tool-figure-outputs')).toBeTruthy()
  fireEvent.click(screen.getByTestId('tool-group-header'))
  await waitFor(() => expect(screen.queryByTestId('notebook-tool-figure-outputs')).toBeNull())
  fireEvent.click(screen.getByTestId('tool-group-header'))
  expect(screen.getByTestId('notebook-tool-figure-outputs')).toBeTruthy()
  rerender(<ReplayActivityGroup step={step} showResults={false} runDetails={runDetails} />)
  expect(screen.queryByTestId('notebook-tool-figure-outputs')).toBeNull()
  expect(run.outputs).toHaveLength(1)
})

it('shows the saved user selection through the shared read-only card without a response form', () => {
  const recorded: PersistedToolActivity = {
    ...activity,
    elicitation: {
      message: 'Choose a method',
      fields: [
        {
          id: 'question_0',
          kind: 'single-select',
          label: 'Method',
          options: [
            { value: 'r', label: 'R analysis' },
            { value: 'python', label: 'Python analysis' }
          ]
        },
        { id: 'question_0_custom', kind: 'text', label: 'Other' }
      ],
      state: 'answered',
      answers: [{ fieldId: 'question_0', value: 'r' }]
    }
  }
  const { container, rerender } = render(
    <ReplayToolRecord activity={recorded} showResults={false} interactive />
  )
  expect(screen.queryByTestId('elicitation-answer-summary')).toBeNull()
  expect(container.querySelector('form')).toBeNull()
  rerender(<ReplayToolRecord activity={recorded} showResults interactive />)
  expect(screen.getByTestId('elicitation-answer-summary').textContent).toContain('R analysis')
  expect(container.querySelector('form')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  fireEvent.click(screen.getByTestId('elicitation-answer-row'))
  expect(screen.getByText('Python analysis')).toBeTruthy()
})
it('keeps drafts distinct from submitted historical answers', () => {
  const recorded = {
    ...activity,
    elicitation: {
      ...activity.elicitation!,
      state: 'pending' as const,
      answers: undefined,
      draftAnswers: [{ fieldId: 'dataset', value: 'DRAFT_ONLY' }]
    }
  }
  const { container } = render(<ReplayToolRecord activity={recorded} showResults interactive />)
  expect(screen.getByText('Saved draft answers')).toBeTruthy()
  expect(screen.getByText('DRAFT_ONLY')).toBeTruthy()
  expect(screen.queryByTestId('elicitation-answer-summary')).toBeNull()
  expect(container.querySelector('form')).toBeNull()
})
it('reveals historical Reviewer findings only after the result boundary with no rerun action', () => {
  const review: ReviewWithChecks = {
    id: 'review',
    projectId: 'p',
    sessionId: 's',
    turnMessageId: 'q',
    scope: { turnMessageId: 'q', blocks: [], artifactVersionIds: [] },
    lifecycle: 'complete',
    outcome: 'flagged',
    model: 'saved model',
    createdAt: 1,
    updatedAt: 2,
    reviewerLog: [{ kind: 'message', text: 'Reviewer saved log' }],
    checks: [
      {
        id: 'check',
        reviewId: 'review',
        status: 'warn',
        resolution: 'open',
        claim: 'SAVED_FINDING',
        evidence: 'SAVED_EVIDENCE',
        sortIndex: 0,
        reflagCount: 0
      }
    ]
  }
  const { rerender } = render(<ReplayReviewRecord review={review} showResults={false} />)
  fireEvent.click(screen.getByTestId('tool-group-header'))
  expect(screen.queryByText('SAVED_FINDING')).toBeNull()
  rerender(<ReplayReviewRecord review={review} showResults />)
  expect(screen.getByText('SAVED_FINDING')).toBeTruthy()
  expect(screen.getByText('SAVED_EVIDENCE')).toBeTruthy()
  expect(screen.queryByText('Reviewer log')).toBeNull()
  expect(screen.queryByText('Reviewer saved log')).toBeNull()
  expect(screen.getByText('Recorded review. No new review is run during replay.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Re-run/ })).toBeNull()
})
