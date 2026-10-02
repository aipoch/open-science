// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { ReplayResource, ReplaySourceIdentity, ReplayStep } from '../../../../shared/replay'
import { indexReplayRun } from '@/lib/replay/run-index'
import { SessionReplayEvidence } from './SessionReplayEvidence'
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
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
describe('static original evidence reader', () => {
  it('loads an archived file only when approached and retains it while scrolling away', async () => {
    let notify: IntersectionObserverCallback
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback
        }
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    const intersect = async (isIntersecting: boolean): Promise<void> => {
      await act(async () =>
        notify([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)
      )
    }

    const resource: ReplayResource = {
      id: 'figure-v2',
      source: 'artifact',
      name: 'sin_plot_r.png',
      projectId: 'project',
      sessionId: 'source',
      artifactId: 'figure',
      versionId: 'v2',
      versionNumber: 2,
      locator: '/archive/figure-v2.png',
      availability: 'recorded',
      mimeType: 'image/png'
    }
    const readPreview = vi.fn().mockResolvedValue({
      content: 'iVBORw0KGgo=',
      encoding: 'base64',
      truncated: false
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { notebook, artifacts: { readPreview } }
    })
    const onOpenResource = vi.fn()
    render(
      <SessionReplayEvidence
        source={source}
        step={{ ...step, kind: 'artifact', runs: [], resourceIds: [resource.id] }}
        resources={[resource]}
        onBack={vi.fn()}
        onOpenResource={onOpenResource}
      />
    )
    expect(readPreview).not.toHaveBeenCalled()
    await intersect(true)
    const image = await screen.findByRole('img', { name: resource.name })
    await intersect(false)
    await intersect(true)
    expect(readPreview).toHaveBeenCalledTimes(1)
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(readPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        sessionId: 'source',
        fileId: 'figure',
        versionId: 'v2'
      })
    )
    expect(screen.queryByText('Recorded data')).toBeNull()
    expect(document.body.textContent).not.toContain('fingerprint')
    fireEvent.click(screen.getByRole('button', { name: 'sin_plot_r.png Version 2' }))
    expect(onOpenResource).toHaveBeenCalledWith(resource)
  })

  it.each(['', undefined])(
    'reads imported Notebook evidence without a live workspace (%s)',
    async (workspaceCwd) => {
      render(
        <SessionReplayEvidence
          source={{ ...source, workspaceCwd }}
          step={step}
          resources={[]}
          onBack={vi.fn()}
          onOpenResource={vi.fn()}
        />
      )
      await screen.findByText(run.script)
      expect(screen.getByText(run.text.stdout)).toBeTruthy()
      expect(notebook.getReference).toHaveBeenCalledWith({
        projectId: 'project',
        sessionId: 'source',
        workspaceCwd: ''
      })
      expect(notebook.state).toHaveBeenCalledWith({
        projectId: 'project',
        sessionId: 'source',
        workspaceCwd: '',
        runIds: [run.runId]
      })
      expect(notebook.mount).not.toHaveBeenCalled()
      expect(notebook.attach).not.toHaveBeenCalled()
      expect(notebook.execute).not.toHaveBeenCalled()
    }
  )

  it('reads the exact recorded run, preserves long outputs and never starts execution', async () => {
    const stdout = `${'archived '.repeat(17_000)}FINAL ORIGINAL RESULT`
    notebook.state.mockResolvedValue({ runs: [{ ...run, text: { ...run.text, stdout } }] })
    const onBack = vi.fn()
    render(
      <SessionReplayEvidence
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
      <SessionReplayEvidence
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
      <SessionReplayEvidence
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
