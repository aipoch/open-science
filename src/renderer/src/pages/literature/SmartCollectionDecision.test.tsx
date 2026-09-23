import { SmartRuleSummary } from './SmartRuleSummary'
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  SmartCollectionAssessment,
  SmartCollectionDecisionActions
} from './SmartCollectionDecision'
import type { SmartCollectionRow } from '../../../../shared/literature-smart-collections'
afterEach(cleanup)

const assessedRow = (
  evidence: NonNullable<SmartCollectionRow['assessment']>['evidence']
): SmartCollectionRow => ({
  id: 'paper',
  title: 'A trial',
  verdict: 'uncertain',
  reason: 'uncertain',
  assessment: {
    model: 'fixture',
    evaluatedAt: 1,
    current: true,
    probabilities: { match: 0.1, 'no-match': 0.1, uncertain: 0.8 },
    evidence
  }
})
it('describes fallback without claiming that the PDF is unavailable', () => {
  render(
    <SmartCollectionAssessment
      row={assessedRow({ coverage: 'unavailable', filename: 'paper.pdf' })}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Evaluation details' }))
  expect(screen.getByText('Evidence: available title and abstract; no PDF text used')).toBeTruthy()
  expect(screen.getByText('paper.pdf')).toBeTruthy()
})
it('explains the absence of a selected quote while retaining source provenance', () => {
  render(
    <SmartCollectionAssessment row={assessedRow({ coverage: 'passages', filename: 'paper.pdf' })} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Evaluation details' }))
  expect(screen.getByText('No supporting passage was selected by the model.')).toBeTruthy()
  expect(screen.getByText('paper.pdf')).toBeTruthy()
})
it.each([
  undefined,
  { ...assessedRow({ coverage: 'unavailable' }).assessment!, model: 'insufficient-evidence' }
])('does not describe an evidence evaluation when no model evaluated the record', (assessment) => {
  render(
    <SmartCollectionAssessment
      row={{ id: 'paper', title: 'A trial', verdict: 'pending', assessment }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Evaluation details' }))
  expect(screen.queryByText(/^Evidence:/)).toBeNull()
})

it('shows the missing-evidence reason only in details and omits fake scores', () => {
  render(
    <SmartCollectionAssessment
      row={{
        id: 'paper',
        title: 'A trial',
        verdict: 'pending',
        reason: 'missing-evidence',
        assessment: { model: 'insufficient-evidence', evaluatedAt: 1, current: true }
      }}
    />
  )
  expect(screen.queryByText('Not enough readable evidence')).toBeNull()
  expect(screen.queryByLabelText('Match score')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Evaluation details' }))
  expect(screen.getByRole('heading', { name: 'Not evaluated by a model' })).toBeTruthy()
  expect(screen.getByText('Not enough readable evidence')).toBeTruthy()
  expect(screen.queryByText('No match')).toBeNull()
  expect(screen.queryByText('Uncertain')).toBeNull()
  expect(screen.queryByText('—')).toBeNull()
  expect(screen.queryByText('No model scores are available for this evaluation.')).toBeNull()
})

it('keeps actual scores and provenance visible but puts generic score guidance behind a help control', () => {
  render(<SmartCollectionAssessment row={assessedRow({ coverage: 'abstract' })} />)
  expect(screen.queryByText('The model could not determine a match')).toBeNull()
  expect(screen.getByText('Match: 10%')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Evaluation details' }))
  expect(
    screen.getByText('Model: fixture').previousElementSibling?.classList.contains('lucide-brain')
  ).toBe(true)
  expect(screen.getByText('80%')).toBeTruthy()
  expect(screen.getByText('Evidence: title and abstract')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Match score' })).toBeTruthy()
  expect(
    screen.queryByText('Model scores for this rule, not paper quality or calibrated probabilities.')
  ).toBeNull()
})

it('opens details on hover without moving focus and closes after leaving', async () => {
  render(<SmartCollectionAssessment row={assessedRow({ coverage: 'abstract' })} />)
  const trigger = screen.getByRole('button', { name: 'Evaluation details' })
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  await screen.findByRole('heading', { name: 'Evaluation details' })
  expect(document.activeElement?.getAttribute('data-slot')).not.toBe('popover-content')
  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'Evaluation details' })).toBeNull()
  )
})

it('keeps compact decision actions accessible without expanding their labels', () => {
  const onDecision = vi.fn()
  render(
    <SmartCollectionDecisionActions
      compact
      disabled={false}
      onDecision={onDecision}
      onReevaluate={vi.fn()}
    />
  )
  for (const label of ['Include', 'Exclude', 'Re-evaluate']) {
    expect(screen.getByRole('button', { name: label }).textContent).toBe('')
    expect(screen.getByRole('button', { name: label }).getAttribute('data-variant')).toBe('outline')
  }
  fireEvent.click(screen.getByRole('button', { name: 'Include' }))
  expect(onDecision).toHaveBeenCalledWith('include')
})

it('shows completion on re-evaluation and restores the action without changing its text', () => {
  const onReevaluate = vi.fn()
  const props = { disabled: false, onDecision: vi.fn(), onReevaluate }
  const { rerender } = render(<SmartCollectionDecisionActions {...props} evaluating />)
  expect(screen.getByRole('button', { name: 'Re-evaluate' }).getAttribute('aria-busy')).toBe('true')
  rerender(<SmartCollectionDecisionActions {...props} completed />)
  const completed = screen.getByRole('button', { name: 'Completed' })
  expect(completed.querySelector('.lucide-check')).toBeTruthy()
  expect(completed.hasAttribute('disabled')).toBe(true)
  expect(completed.textContent).toBe('Re-evaluate')
  rerender(<SmartCollectionDecisionActions {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Re-evaluate' }))
  expect(onReevaluate).toHaveBeenCalledOnce()
})

it('shows version differences without a duplicate rule disclosure', async () => {
  const row = assessedRow({ coverage: 'abstract' })
  row.assessment = {
    ...row.assessment!,
    current: false,
    ruleRevision: 1,
    currentRuleRevision: 2,
    rule: JSON.stringify({
      description: 'Old background',
      inclusion: 'Original studies',
      exclusion: 'Reviews'
    })
  }
  const { rerender } = render(<SmartCollectionAssessment row={row} />)
  expect(screen.queryByText('Old background')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Evaluation details' }))
  expect(screen.getByText('Evaluated with rule #1; current rule #2')).toBeTruthy()
  expect(screen.queryByText('Old background')).toBeNull()
  expect(screen.getByText('Evaluated with rule #1; current rule #2').closest('details')).toBeNull()
  const guidance =
    'This result is outdated. Update the collection to evaluate the current rule and evidence.'
  expect(screen.queryByText(guidance)).toBeNull()
  const outdatedHelp = screen.getByRole('button', { name: 'Outdated' })
  fireEvent.focus(outdatedHelp)
  expect(await screen.findByRole('tooltip')).toHaveProperty(
    'textContent',
    expect.stringContaining(guidance)
  )
  fireEvent.blur(outdatedHelp)
  rerender(
    <SmartCollectionAssessment
      row={{ ...row, assessment: { ...row.assessment!, current: true, currentRuleRevision: 1 } }}
    />
  )
  expect(screen.queryByText('Evaluated with rule #1; current rule #1')).toBeNull()
})

it('loads history only on expansion and offers retry without duplicating history controls', async () => {
  const transact = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ smartHistory: { currentRevision: 2, entries: [] } })
  const original = window.api
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
  try {
    render(
      <SmartCollectionAssessment
        row={{ ...assessedRow({ coverage: 'abstract' }), collectionId: 'collection' }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Evaluation details' }))
    expect(screen.getAllByText('Evaluation history')).toHaveLength(1)
    expect(transact).not.toHaveBeenCalled()
    const details = screen.getByText('Evaluation history').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    // JSDOM has a zero-sized anchor, so Radix hides the positioned portal.
    await screen.findByRole('alert', { hidden: true })
    fireEvent.click(screen.getByText('Retry'))
    await screen.findByText('No evaluation history yet.')
    expect(transact).toHaveBeenCalledTimes(2)
    expect(transact).toHaveBeenLastCalledWith({
      kind: 'read-smart-history',
      collectionId: 'collection',
      itemId: 'paper',
      offset: 0
    })
  } finally {
    Object.defineProperty(window, 'api', { configurable: true, value: original })
  }
})

it('shortens long historical rules and lets users expand and collapse the complete text', () => {
  const inclusion = 'Eligible randomized controlled trials. '.repeat(8)
  render(
    <SmartRuleSummary
      compact
      rule={JSON.stringify({ description: 'Trial scope', inclusion, exclusion: '' })}
    />
  )
  expect(screen.queryByText(inclusion.trim())).toBeNull()
  expect(screen.getByText(`${inclusion.slice(0, 80).trimEnd()}…`)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
  expect(screen.getByText(inclusion.trim())).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(screen.queryByText(inclusion.trim())).toBeNull()
})
