// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolActivity } from '@/stores/session-store'
import type { AcpPermissionRequest } from '../../../../shared/acp'
import { buildToolActivityDetails } from './workspace-tool-activity-details'
import { buildNotebookToolSummary, readNotebookToolResult } from './notebook-tool-presentation'
import { WorkspaceToolDetailsRow } from './WorkspaceToolDetailsRow'
import { PermissionApprovalControls } from './PermissionApprovalControls'
import { WorkspaceToolSummaryCard } from './WorkspaceToolSummaryCard'

const activity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: '',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})
const permission = (tool: string, rawInput: unknown = {}): AcpPermissionRequest => ({
  requestId: 'request-1',
  sessionId: 'session-1',
  toolCallId: 'tool-1',
  title: tool,
  mcpIdentity: `open-science-notebook/${tool}`,
  isMcp: true,
  providerToolName: tool,
  rawInput,
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'deny', name: 'Reject once', kind: 'reject_once' }
  ]
})

const restart = { kernelStatus: 'idle', status: 'restarted', cells: 3 }
it('does not confirm a restart when the final activity failed', () => {
  const details = buildToolActivityDetails(
    activity({
      title: 'open-science-notebook/notebook_restart',
      status: 'failed',
      rawOutput: {
        ...restart,
        note: 'Kernel restarted; in-memory variables cleared. Run history is preserved.'
      }
    })
  )!
  const section = details.sections[0]
  if (section.kind !== 'summary') throw new Error('Expected a summary')
  expect(section.summary.note).toBeUndefined()
  expect(section.summary.fields).not.toContainEqual({ label: 'Status', value: 'Restarted' })
  expect(section.summary.error).toBe('Failed')
  const html = renderToStaticMarkup(<WorkspaceToolSummaryCard summary={section.summary} />)
  expect(html).not.toContain('Kernel restarted')
  expect(html).not.toContain('variables cleared')
})

it('bounds visible error previews and marks truncation', () => {
  const html = renderToStaticMarkup(
    <WorkspaceToolSummaryCard
      summary={{
        title: 'Notebook state',
        fields: [],
        error: 'x'.repeat(2100) + 'hidden-tail',
        rows: [{ title: 'failed-cell', error: 'y'.repeat(2100) + 'hidden-tail' }]
      }}
    />
  )
  expect(html).toContain('Output truncated')
  expect(html).not.toContain('hidden-tail')
  expect(html).not.toContain('x'.repeat(2001))
  expect(html).not.toContain('y'.repeat(2001))
})
it.each([
  'mcp__open-science-notebook__notebook_restart',
  'mcp__open_science_notebook__notebook_restart',
  'open-science-notebook_notebook_restart',
  'open_science_notebook_notebook_restart',
  'mcp.open-science-notebook.notebook_restart',
  'open-science-notebook/notebook_restart'
])('renders a restart receipt for provider identity %s', (identity) => {
  const item = activity({
    title: identity,
    rawOutput: {
      result: { content: [{ type: 'text', text: JSON.stringify(restart) }] },
      error: null
    }
  })
  const details = buildToolActivityDetails(item)!
  const html = renderToStaticMarkup(
    <WorkspaceToolDetailsRow activity={item} details={details} isExpanded onToggle={vi.fn()} />
  )
  expect(html).toContain('tool-summary-card')
  expect(html).toContain('Run history preserved')
  expect(html).toContain('Idle')
  expect(html).toContain('<details')
  expect(html).not.toContain('<details open')
})

it('keeps lookalike servers on generic details', () => {
  const details = buildToolActivityDetails(
    activity({ title: 'mcp__open-science-notebook-staging__notebook_state', rawOutput: restart })
  )
  expect(details?.sections.some((section) => section.kind === 'summary')).toBe(false)
})

it('does not invent a successful restart from malformed or failed output', () => {
  expect(readNotebookToolResult('not JSON')).toBeUndefined()
  const details = buildToolActivityDetails(
    activity({
      title: 'open-science-notebook/notebook_restart',
      status: 'failed',
      rawOutput: 'Kernel unavailable'
    })
  )!
  expect(details.sections[0]).toMatchObject({
    kind: 'summary',
    summary: { error: 'Kernel unavailable' }
  })
  expect(JSON.stringify(details)).not.toContain('Run history preserved')
})

it('shows runtime pagination, bindings and availability without fetching more results', () => {
  const summary = buildNotebookToolSummary(
    'open-science-notebook/list_notebook_runtimes',
    { limit: 40 },
    {
      runtimeCount: 42,
      nextOffset: 40,
      runtimes: [
        {
          language: 'python',
          label: 'default-python',
          version: '3.12',
          source: 'managed',
          bound: true,
          runnable: true
        },
        { language: 'r', label: 'default-r', runnable: false, reason: 'Runtime recovering' }
      ]
    }
  )!
  expect(summary.rows?.[0]).toMatchObject({ title: 'default-python', status: 'Bound' })
  expect(summary.rows?.[1].error).toBe('Runtime recovering')
  expect(summary.note).toContain('More runtimes')
  expect(summary.fields).toContainEqual({ label: 'Limit', value: '40' })
})

it('keeps binding errors and partial mutation receipts visible', () => {
  const summary = buildNotebookToolSummary(
    'open-science-notebook/notebook_bind_runtime',
    { arguments: { language: 'r', runtimeId: '/envs/R' } },
    { ok: false, bindingChanged: true, error: 'Could not confirm storage' }
  )!
  expect(summary.error).toBe('Could not confirm storage')
  expect(summary.note).toContain('binding changed')
  expect(summary.fields).toContainEqual({ label: 'Runtime', value: '/envs/R', expandable: true })
})

it('summarizes compacted state and retains the latest failed run diagnostic', () => {
  const summary = buildNotebookToolSummary(
    'open-science-notebook/notebook_state',
    {},
    {
      kernelStatus: 'idle',
      cellCount: 3,
      runCount: 4,
      environmentCount: 1,
      historyCompacted: true,
      recentRuns: [
        {
          cellId: 'pie-plot-r',
          kernelKind: 'r',
          status: 'failed',
          executionCount: 4,
          outputPreview: 'RUNTIME_RECOVERY_BLOCKED: restart the app'
        }
      ]
    }
  )!
  expect(summary.fields).toContainEqual({ label: 'Runs', value: '4' })
  expect(summary.rows?.[0]).toMatchObject({
    title: 'pie-plot-r',
    status: 'Failed',
    error: 'RUNTIME_RECOVERY_BLOCKED: restart the app'
  })
  expect(summary.note).toContain('Full history')
})

describe('permission summaries', () => {
  it.each([false, true])(
    'shows the actual file source and redacts inline bytes (encoded source: %s)',
    (encoded) => {
      const source = { kind: 'localPath', path: '/research/data/sin_curve.png' }
      const request = {
        ...permission('write_artifact_file'),
        mcpIdentity: 'open-science-artifacts/write_artifact_file',
        rawInput: {
          filename: 'sin_curve.png',
          mimeType: 'image/png',
          source: encoded ? JSON.stringify(source) : source,
          content: 'private-base64-bytes',
          producerRunId: 'run-123'
        }
      }
      const html = renderToStaticMarkup(
        <PermissionApprovalControls requests={[request]} onRespond={vi.fn()} />
      )
      expect(html).toContain('tool-summary-card')
      expect(html).toContain('/research/data/sin_curve.png')
      expect(html).toContain('run-123')
      expect(html).toContain('File content omitted')
      expect(html).not.toContain('private-base64-bytes')
    }
  )
  it.each([
    'notebook_restart',
    'notebook_state',
    'notebook_bind_runtime',
    'list_notebook_runtimes'
  ])('shows %s before execution with existing approval choices', (tool) => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          permission(tool, { language: 'r', runtimeId: '/long/runtime/bin/R', limit: 40 })
        ]}
        onRespond={vi.fn()}
      />
    )
    expect(html).toContain('tool-summary-card')
    expect(html).toContain('permission-actions')
    expect(html).not.toContain('Run history preserved.')
    if (tool === 'notebook_restart') expect(html).toContain('Clears in-memory variables')
    if (tool === 'notebook_bind_runtime') expect(html).toContain('/long/runtime/bin/R')
  })
})

it.each([false, true])('renders runtime switch receipts (partial failure: %s)', (failed) => {
  const result = failed
    ? {
        ok: false,
        bindingChanged: true,
        error: 'Could not confirm storage',
        target: { runtimeId: '/envs/analysis-r/bin/R' }
      }
    : {
        bound: {
          language: 'r',
          runtimeId: '/envs/analysis-r/bin/R',
          label: 'analysis-r',
          version: '4.4.3',
          source: 'managed',
          status: 'active'
        }
      }
  const item = activity({
    title: 'mcp__open_science_notebook__notebook_switch_runtime',
    status: failed ? 'failed' : 'completed',
    rawInput: { language: 'r', runtimeId: '/envs/analysis-r/bin/R' },
    rawOutput: {
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      error: null
    }
  })
  const details = buildToolActivityDetails(item)!
  const html = renderToStaticMarkup(
    <WorkspaceToolDetailsRow activity={item} details={details} isExpanded onToggle={vi.fn()} />
  )
  expect(html).toContain('tool-summary-card')
  expect(html).toContain('Switch notebook runtime')
  expect(html).toContain('/envs/analysis-r/bin/R')
  if (failed) {
    expect(html).toContain('Could not confirm storage')
    expect(html).toContain('The runtime binding changed despite the error.')
  } else {
    expect(html).toContain('analysis-r')
    expect(html).toContain('4.4.3')
    expect(html).toContain('Active')
  }
})

it('shows the switch target and memory impact before approval', () => {
  const html = renderToStaticMarkup(
    <PermissionApprovalControls
      requests={[
        permission('notebook_switch_runtime', {
          language: 'r',
          runtimeId: 'C:\\runtimes\\analysis-r\\R.exe'
        })
      ]}
      onRespond={vi.fn()}
    />
  )
  expect(html).toContain('tool-summary-card')
  expect(html).toContain('Switch notebook runtime')
  expect(html).toContain('C:\\runtimes\\analysis-r\\R.exe')
  expect(html).toContain(
    'Clears memory in the selected language kernel. Other kernels are unaffected.'
  )
  expect(html).toContain('permission-actions')
})
