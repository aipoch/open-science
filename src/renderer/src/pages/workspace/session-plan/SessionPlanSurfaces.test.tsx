// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { PlanPreviewSurface, PlanProgressChip, WorkspacePlanCard } from './SessionPlanSurfaces'
import { isPlanProgressVisible } from './plan-progress'

afterEach(cleanup)

const projection: ActivePlanProjection = {
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 3,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  document: {
    schema_version: 1,
    task_summary: 'Analyze one dataset',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Analysis result'],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: { 'Analyze the data': { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
}

const multiLevelProjection: ActivePlanProjection = {
  ...projection,
  document: {
    schema_version: 1,
    task_summary: 'Compare cohorts and draft a report',
    phases: [
      {
        name: 'Preparation',
        delegations: [
          {
            name: 'Data intake',
            steps: [
              { title: 'Read the dictionary', description: 'Confirm field meanings.' },
              { title: 'Validate inputs', description: 'Check both cohorts.' }
            ]
          }
        ]
      },
      {
        name: 'Parallel analysis',
        delegations: [
          {
            name: 'Cohort comparison',
            steps: [{ title: 'Compare cohorts', description: 'Calculate differences.' }]
          },
          {
            name: 'Evidence review',
            steps: [{ title: 'Review evidence', description: 'Check supporting evidence.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Cohort comparison', 'Review-ready report'],
    feasibility: { confidence: 'medium', rationale: 'Cohort definitions may need confirmation.' }
  },
  stepStatuses: {
    'Read the dictionary': { status: 'completed', updatedAt: 40, notes: 'Internal result.' },
    'Validate inputs': { status: 'in_progress', updatedAt: 41, notes: 'Internal progress.' },
    'Compare cohorts': { status: 'blocked', updatedAt: 42, notes: 'Cohort B is undefined.' }
  },
  stepStates: {
    'Read the dictionary': { status: 'completed', notes: 'Internal result.' },
    'Validate inputs': { status: 'in_progress', notes: 'Internal progress.' },
    'Compare cohorts': { status: 'blocked', notes: 'Cohort B is undefined.' },
    'Review evidence': { status: 'not_run' }
  },
  counts: { phases: 2, delegations: 3, steps: 4, completed: 0, inProgress: 0 }
}

describe('Session Plan renderer surfaces', () => {
  it('renders the compact English proposal card and shares approval with Open', () => {
    const onOpen = vi.fn()
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<WorkspacePlanCard projection={projection} onOpen={onOpen} onRespond={onRespond} />)

    expect(screen.getByText('Plan ready for review')).toBeTruthy()
    expect(screen.getByText('Analyze one dataset')).toBeTruthy()
    expect(screen.queryByText('1 phase · 1 delegation · 1 step')).toBeNull()
    expect(screen.getByText(/high confidence/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(screen.getAllByRole('button').every((button) => button.dataset.slot === 'button')).toBe(
      true
    )
    expect(screen.getByLabelText('Respond to Plan').dataset.slot).toBe('textarea')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('approved')
  })

  it('removes the compact card after a successful approval', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <WorkspacePlanCard projection={projection} onOpen={vi.fn()} onRespond={onRespond} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('approved'))
    expect(view.container.querySelector('article')).toBeNull()
  })

  it('drops nested card chrome when embedded in the shared composer panel', () => {
    const view = render(
      <WorkspacePlanCard embedded projection={projection} onOpen={vi.fn()} onRespond={vi.fn()} />
    )

    const card = view.container.querySelector('article')
    expect(card?.classList.contains('rounded-none')).toBe(true)
    expect(card?.classList.contains('border-0')).toBe(true)
    expect(card?.classList.contains('shadow-none')).toBe(true)
  })

  it('keeps a persistence-blocked Plan readable without response controls', () => {
    render(
      <WorkspacePlanCard
        enabled={false}
        projection={projection}
        onOpen={vi.fn()}
        onRespond={vi.fn()}
        onSubmitResponse={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByLabelText('Respond to Plan')).toBeNull()
  })

  it('submits inline revision feedback as a user Message', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const onSubmitResponse = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <WorkspacePlanCard
        projection={projection}
        onOpen={vi.fn()}
        onRespond={onRespond}
        onSubmitResponse={onSubmitResponse}
      />
    )

    const input = view.container.querySelector('textarea')!
    fireEvent.change(input, { target: { value: 'Split the analysis by cohort.' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(onSubmitResponse).toHaveBeenCalledWith('Split the analysis by cohort.')
    )
    expect(view.container.querySelector('article')).toBeNull()
    expect(onRespond).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /request changes/i })).toBeNull()
  })

  it.each(['looks good', 'dismiss', '批准执行', '取消计划', '先修改后再批准'])(
    'submits natural-language text %s as feedback without inferring a decision',
    async (text) => {
      const onRespond = vi.fn().mockResolvedValue(undefined)
      const onSubmitResponse = vi.fn().mockResolvedValue(undefined)
      const view = render(
        <WorkspacePlanCard
          projection={projection}
          onOpen={vi.fn()}
          onRespond={onRespond}
          onSubmitResponse={onSubmitResponse}
        />
      )

      const input = view.container.querySelector('textarea')!
      fireEvent.change(input, { target: { value: text } })
      fireEvent.submit(input.closest('form')!)

      await waitFor(() => expect(onSubmitResponse).toHaveBeenCalledWith(text))
      expect(onRespond).not.toHaveBeenCalled()
      expect(view.container.querySelector('article')).toBeNull()
    }
  )

  it('keeps a replaced card readable with the exact stale warning and no approval entry points', () => {
    render(
      <WorkspacePlanCard
        projection={projection}
        stale
        onOpen={vi.fn()}
        onRespond={vi.fn()}
        onSubmitResponse={vi.fn()}
      />
    )

    const warning = screen.getByText(
      /A newer plan is active\. This plan can no longer be approved\./u
    )
    expect(warning.className).toContain('bg-muted')
    expect(warning.className).not.toContain('amber')
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(screen.queryByLabelText('Respond to Plan')).toBeNull()
  })

  it('offers Download, Dismiss, and Approve in active Preview and makes replaced Preview read-only', () => {
    const onDownload = vi.fn()
    const onRespond = vi.fn()
    const { rerender } = render(
      <PlanPreviewSurface projection={projection} onDownload={onDownload} onRespond={onRespond} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download Plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDownload).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('approved')

    rerender(
      <PlanPreviewSurface
        projection={projection}
        stale
        onDownload={onDownload}
        onRespond={onRespond}
      />
    )
    expect(
      screen.getByText(/This plan has been replaced by another plan and is no longer current\./u)
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download Plan' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('submits only the first Preview decision while its response is pending', () => {
    const onRespond = vi.fn(() => new Promise<void>(() => undefined))
    render(<PlanPreviewSurface projection={projection} onRespond={onRespond} />)

    const dismiss = screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement
    fireEvent.click(dismiss)

    expect(dismiss.disabled).toBe(true)
    expect(approve.disabled).toBe(true)
    expect(dismiss.closest('[aria-busy="true"]')).not.toBeNull()
    fireEvent.click(approve)

    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('rejected')
  })

  it('renders the three-level Plan preview', () => {
    const onDownload = vi.fn().mockResolvedValue(undefined)
    const onToggleFullScreen = vi.fn()
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(
      <PlanPreviewSurface
        projection={multiLevelProjection}
        onDownload={onDownload}
        onToggleFullScreen={onToggleFullScreen}
        onRespond={onRespond}
        isFullScreen={false}
      />
    )
    expect(screen.getByText('PHASE 1')).toBeTruthy()
    expect(screen.getByText('PHASE 2')).toBeTruthy()
    expect(
      screen.getByText(
        'Complete 2 phases in order. Delegations within a phase may run in parallel.'
      )
    ).toBeTruthy()
    expect(screen.getByText('Data intake')).toBeTruthy()
    expect(screen.getByText('primary agent')).toBeTruthy()
    expect(screen.getAllByText('runs in parallel')).toHaveLength(2)
    expect(screen.getAllByText('Cohort comparison')).toHaveLength(2)
    expect(screen.getByText('Evidence review')).toBeTruthy()
    expect(screen.getByText('Compare cohorts')).toBeTruthy()
    expect(screen.getByText('Desired outputs')).toBeTruthy()
    expect(screen.getByText('Review-ready report')).toBeTruthy()
    expect(screen.getByText('Cohort B is undefined.')).toBeTruthy()
    expect(screen.queryByText('Internal result.')).toBeNull()
    expect(screen.queryByText('Internal progress.')).toBeNull()
    expect(screen.getByText('SCOPE & FEASIBILITY · medium confidence')).toBeTruthy()
    expect(document.querySelector('[data-slot="scroll-area"]')).not.toBeNull()
    expect(screen.getAllByRole('button').every((button) => button.dataset.slot === 'button')).toBe(
      true
    )
    expect(screen.getByRole('button', { name: 'Download Plan' }).textContent).toContain('Download')
    expect(document.querySelector('header')?.className).toContain('h-9')
    fireEvent.click(screen.getByRole('button', { name: 'Download Plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    expect(onDownload).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('rejected')
    expect(onToggleFullScreen).toHaveBeenCalledOnce()
  })

  it('keeps a long Preview summary compact while retaining its full text at the bottom', () => {
    const longSummary =
      'Compare longitudinal cohorts, validate every source, reconcile conflicting evidence, produce publication-ready figures, and draft a complete review report with limitations.'
    render(
      <PlanPreviewSurface
        projection={{
          ...projection,
          document: { ...projection.document, task_summary: longSummary }
        }}
      />
    )

    const heading = screen.getByRole('heading', { level: 1, name: longSummary })
    expect(heading.className).toContain('line-clamp-3')
    const summaryCopies = screen.getAllByText(longSummary)
    expect(summaryCopies).toHaveLength(2)
    const fullSummary = summaryCopies.find((element) => element !== heading)
    expect(fullSummary?.className).toContain('text-xs')
    expect(fullSummary?.parentElement?.lastElementChild).toBe(fullSummary)
  })

  it('reveals the complete Preview summary after a deliberate pointer hover', async () => {
    vi.useFakeTimers()
    const longSummary =
      'Compare longitudinal cohorts, validate every source, reconcile conflicting evidence, produce publication-ready figures, and draft a complete review report with limitations.'
    try {
      render(
        <PlanPreviewSurface
          projection={{
            ...projection,
            document: { ...projection.document, task_summary: longSummary }
          }}
        />
      )

      const heading = screen.getByRole('heading', { level: 1, name: longSummary })
      fireEvent.pointerMove(heading, { pointerType: 'mouse' })
      expect(screen.queryByRole('tooltip')).toBeNull()

      await act(() => vi.advanceTimersByTimeAsync(1_199))
      expect(screen.queryByRole('tooltip')).toBeNull()
      await act(() => vi.advanceTimersByTimeAsync(1))
      expect(screen.getByRole('tooltip').textContent).toBe(longSummary)
    } finally {
      vi.useRealTimers()
    }
  })

  it('overlays every public step status while hiding ordinary status notes', () => {
    const steps = [
      'Not started step',
      'Running step',
      'Completed step',
      'Blocked step',
      'Skipped step',
      'Not run step'
    ]
    const statusProjection: ActivePlanProjection = {
      ...projection,
      approval: 'approved',
      lifecycle: 'blocked',
      document: {
        ...projection.document,
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: steps.map((title) => ({ title, description: `${title} description.` }))
              }
            ]
          }
        ]
      },
      stepStatuses: {
        'Running step': { status: 'in_progress', updatedAt: 1, notes: 'Hidden running note.' },
        'Completed step': { status: 'completed', updatedAt: 2, notes: 'Hidden completed note.' },
        'Blocked step': { status: 'blocked', updatedAt: 3, notes: 'Visible blocked note.' },
        'Skipped step': { status: 'skipped', updatedAt: 4, notes: 'Visible skipped note.' }
      },
      stepStates: {
        'Not started step': { status: 'not_started' },
        'Running step': { status: 'in_progress', notes: 'Hidden running note.' },
        'Completed step': { status: 'completed', notes: 'Hidden completed note.' },
        'Blocked step': { status: 'blocked', notes: 'Visible blocked note.' },
        'Skipped step': { status: 'skipped', notes: 'Visible skipped note.' },
        'Not run step': { status: 'not_run' }
      },
      counts: { phases: 1, delegations: 1, steps: 6, completed: 1, inProgress: 0 }
    }

    render(<PlanPreviewSurface projection={statusProjection} />)

    for (const [title, label] of [
      ['Not started step', 'not started'],
      ['Running step', 'in progress'],
      ['Completed step', 'completed'],
      ['Blocked step', 'blocked'],
      ['Skipped step', 'skipped'],
      ['Not run step', 'not run']
    ]) {
      expect(screen.getByLabelText(`${title} status: ${label}`)).toBeTruthy()
    }
    expect(screen.getByText('Visible blocked note.')).toBeTruthy()
    expect(screen.getByText('Visible skipped note.')).toBeTruthy()
    expect(screen.queryByText('Hidden running note.')).toBeNull()
    expect(screen.queryByText('Hidden completed note.')).toBeNull()
  })

  it('renders the progress chip with completed/total steps and opens on click', () => {
    const onOpen = vi.fn()
    render(
      <PlanProgressChip
        projection={{
          ...projection,
          approval: 'approved',
          lifecycle: 'in_progress',
          stepStatuses: {
            'Analyze the data': { status: 'in_progress', updatedAt: 1 },
            'Review evidence': { status: 'in_progress', updatedAt: 1 }
          },
          stepStates: {
            'Analyze the data': { status: 'in_progress' },
            'Review evidence': { status: 'in_progress' }
          },
          counts: { phases: 1, delegations: 2, steps: 2, completed: 0, inProgress: 2 }
        }}
        onOpen={onOpen}
      />
    )

    const chip = screen.getByRole('button', { name: /open plan, step 0 of 2, 2 running/i })
    expect(chip.dataset.slot).toBe('button')
    expect(chip.textContent).toContain('2 running')
    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('renders the lifecycle label on the Plan card without a status banner', () => {
    const { rerender } = render(
      <WorkspacePlanCard
        projection={{
          ...projection,
          approval: 'approved',
          lifecycle: 'in_progress',
          stepStatuses: {
            'Analyze the data': { status: 'in_progress', updatedAt: 1 }
          },
          stepStates: { 'Analyze the data': { status: 'in_progress' } }
        }}
        onOpen={vi.fn()}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByText('Plan in progress')).toBeTruthy()
    expect(screen.queryByText(/Send a message to continue/u)).toBeNull()

    rerender(
      <WorkspacePlanCard
        projection={{ ...multiLevelProjection, approval: 'approved', lifecycle: 'blocked' }}
        onOpen={vi.fn()}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByText('Plan blocked')).toBeTruthy()
    expect(screen.queryByText(/Unreachable downstream/u)).toBeNull()

    rerender(
      <WorkspacePlanCard
        projection={{
          ...projection,
          approval: 'approved',
          lifecycle: 'completed',
          counts: { ...projection.counts, completed: 1 }
        }}
        onOpen={vi.fn()}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByText('Plan completed')).toBeTruthy()
    expect(screen.queryByText(/remains active until a new plan/u)).toBeNull()
  })

  it('shows the progress chip for durable in-progress work', () => {
    render(
      <PlanProgressChip
        projection={{
          ...projection,
          approval: 'approved',
          lifecycle: 'in_progress',
          stepStatuses: {
            'Analyze the data': { status: 'in_progress', updatedAt: 1 }
          },
          stepStates: {
            'Analyze the data': { status: 'in_progress' }
          },
          counts: { ...projection.counts, inProgress: 1 }
        }}
        onOpen={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /open plan, step 0 of 1/i })).toBeTruthy()
    expect(screen.getByText(/running/u)).toBeTruthy()
  })

  it('hides the progress chip for awaiting-approval and terminal lifecycles', () => {
    const approved = {
      ...projection,
      approval: 'approved' as const,
      lifecycle: 'approved' as const
    }
    expect(isPlanProgressVisible(approved)).toBe(true)
    expect(isPlanProgressVisible({ ...approved, lifecycle: 'in_progress' as const })).toBe(true)
    expect(isPlanProgressVisible({ ...approved, lifecycle: 'awaiting_approval' as const })).toBe(
      false
    )
    expect(isPlanProgressVisible({ ...approved, lifecycle: 'completed' as const })).toBe(false)
    expect(isPlanProgressVisible({ ...approved, lifecycle: 'blocked' as const })).toBe(false)
    expect(isPlanProgressVisible({ ...approved, lifecycle: 'rejected' as const })).toBe(false)
  })

  it('shows a stable invalid-schema state while preserving immutable download', () => {
    const onDownload = vi.fn().mockResolvedValue(undefined)
    render(
      <PlanPreviewSurface
        projection={
          {
            ...projection,
            document: { ...projection.document, schema_version: 2 }
          } as unknown as ActivePlanProjection
        }
        onDownload={onDownload}
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('Invalid Plan document')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download Plan' }))
    expect(onDownload).toHaveBeenCalledOnce()
  })

  it('treats a missing schema discriminator as an invalid persisted Plan', () => {
    render(
      <PlanPreviewSurface
        projection={
          {
            ...projection,
            document: { ...projection.document, schema_version: undefined }
          } as unknown as ActivePlanProjection
        }
        onDownload={vi.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('Invalid Plan document')
    expect(screen.getByRole('button', { name: 'Download Plan' })).toBeTruthy()
  })

  it('ignores legacy continuation fields when presenting approved Plan progress', () => {
    render(
      <PlanPreviewSurface
        projection={
          {
            ...projection,
            approval: 'approved',
            lifecycle: 'in_progress',
            continuationState: 'interrupted',
            requiresExplicitContinuation: true
          } as unknown as ActivePlanProjection
        }
      />
    )

    expect(screen.queryByText(/Send a message to continue/u)).toBeNull()
    expect(screen.getByRole('heading', { name: 'Analyze one dataset' })).toBeTruthy()
  })
})
