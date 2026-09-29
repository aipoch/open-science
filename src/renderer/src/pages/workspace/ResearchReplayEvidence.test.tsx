// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { ReplaySourceIdentity, ReplayStep } from '../../../../shared/replay'
import { indexReplayRun } from '@/lib/replay/run-index'
import { ResearchReplayEvidence } from './ResearchReplayEvidence'
vi.mock('react-i18next', () => createI18nTestStub())
const source: ReplaySourceIdentity = {
  projectId: 'project',
  sessionId: 'source',
  title: 'Research',
  fingerprint: 'original',
  workspaceCwd: '/archive'
}
const run: NotebookRunRecord = {
  runId: 'recorded-run',
  cellId: 'cell',
  source: 'agent',
  kernelKind: 'python',
  script: 'print("original result")',
  status: 'completed',
  startedAt: 1,
  endedAt: 2,
  text: { stdout: 'original result', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
}
const step: ReplayStep = {
  id: 'run-step',
  kind: 'notebook',
  branchId: 'main',
  evidence: [],
  activities: [],
  runs: [indexReplayRun(run)],
  resourceIds: [],
  issues: [],
  startMs: 0,
  durationMs: 1000,
  endMs: 1000
}
const notebook = {
  getReference: vi.fn(),
  state: vi.fn(),
  mount: vi.fn(),
  attach: vi.fn(),
  execute: vi.fn()
}
beforeEach(() => {
  vi.clearAllMocks()
  notebook.getReference.mockResolvedValue({ notebookSessionRoot: '/recorded' })
  notebook.state.mockResolvedValue({ runs: [run] })
  Object.defineProperty(window, 'api', { configurable: true, value: { notebook } })
})
afterEach(cleanup)
describe('static original evidence reader', () => {
  it('reads the exact recorded run, preserves long outputs and never starts execution', async () => {
    const stdout = `${'archived '.repeat(17_000)}FINAL ORIGINAL RESULT`
    notebook.state.mockResolvedValue({ runs: [{ ...run, text: { ...run.text, stdout } }] })
    const onBack = vi.fn()
    render(
      <ResearchReplayEvidence
        source={source}
        step={step}
        resources={[]}
        onBack={onBack}
        onOpenResource={vi.fn()}
      />
    )
    await screen.findByText(run.script)
    expect(screen.getByText((text) => text.endsWith('FINAL ORIGINAL RESULT'))).toBeTruthy()
    expect(notebook.state).toHaveBeenCalledWith({
      projectId: 'project',
      sessionId: 'source',
      workspaceCwd: '/archive',
      runIds: ['recorded-run']
    })
    expect(notebook.mount).not.toHaveBeenCalled()
    expect(notebook.attach).not.toHaveBeenCalled()
    expect(notebook.execute).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Back to replay' }))
    expect(onBack).toHaveBeenCalledOnce()
  })
  it('does not substitute a mismatched or missing archived run', async () => {
    notebook.state.mockResolvedValue({
      runs: [{ ...run, cellId: 'other-cell', script: 'unrelated data' }]
    })
    render(
      <ResearchReplayEvidence
        source={source}
        step={step}
        resources={[]}
        onBack={vi.fn()}
        onOpenResource={vi.fn()}
      />
    )
    await screen.findByText('The recorded evidence is unavailable.')
    expect(screen.queryByText('unrelated data')).toBeNull()
    notebook.state.mockResolvedValue({ runs: [run] })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText(run.script)
  })
  it('reports absent Notebook records without creating a Notebook', async () => {
    notebook.getReference.mockResolvedValue(null)
    render(
      <ResearchReplayEvidence
        source={source}
        step={step}
        resources={[]}
        onBack={vi.fn()}
        onOpenResource={vi.fn()}
      />
    )
    await screen.findByText('The recorded evidence is unavailable.')
    expect(notebook.state).not.toHaveBeenCalled()
    expect(notebook.mount).not.toHaveBeenCalled()
  })
})
