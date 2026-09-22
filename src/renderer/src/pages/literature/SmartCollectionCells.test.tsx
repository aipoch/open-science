// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SmartCollectionCells, type SmartCollectionCellActions } from './SmartCollectionDecision'
import type { SmartCollectionRow } from '../../../../shared/literature-smart-collections'

const renders = vi.hoisted(() => ({ assessments: 0 }))
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/ui/popover')>()
  return {
    ...original,
    Popover: (props: React.ComponentProps<typeof original.Popover>) => {
      renders.assessments++
      return <original.Popover {...props} />
    }
  }
})
afterEach(cleanup)

it('skips 100 unchanged assessment trees, updates only changed rows, and calls current handlers', () => {
  const rows: SmartCollectionRow[] = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    title: String(i),
    verdict: 'match',
    assessment: {
      model: 'fixture',
      current: true,
      evaluatedAt: 1,
      probabilities: { match: 0.9, 'no-match': 0.05, uncertain: 0.05 }
    }
  }))
  const oldDecision = vi.fn()
  const actions: { current: SmartCollectionCellActions } = {
    current: { update: vi.fn(), reevaluate: vi.fn(), decide: oldDecision }
  }
  const table = (data: SmartCollectionRow[]): React.JSX.Element => (
    <TooltipProvider>
      <table>
        <tbody>
          {data.map((row) => (
            <tr key={row.id}>
              <SmartCollectionCells
                itemId={row.id}
                row={row}
                actions={actions}
                disabled={false}
                updateDisabled={false}
                evaluating={false}
              />
            </tr>
          ))}
        </tbody>
      </table>
    </TooltipProvider>
  )
  const view = render(table(rows))
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
  renders.assessments = 0
  const latestDecision = vi.fn()
  actions.current = { ...actions.current, decide: latestDecision }
  view.rerender(table(rows))
  expect(renders.assessments).toBe(0)

  view.rerender(table(rows.map((row, i) => (i === 0 ? { ...row, override: 'exclude' } : row))))
  expect(renders.assessments).toBe(1)
  fireEvent.click(screen.getAllByRole('button', { name: 'Include' })[0])
  expect(latestDecision).toHaveBeenCalledWith('0', 'include')
  expect(oldDecision).not.toHaveBeenCalled()
})
