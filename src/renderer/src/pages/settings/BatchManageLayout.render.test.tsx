// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BatchManageLayout, BatchManageReview } from './BatchManageLayout'

afterEach(cleanup)

function Harness({
  busy = false,
  onToggleAll = vi.fn()
}: {
  busy?: boolean
  onToggleAll?: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState(1)
  const [review, setReview] = useState(false)
  const [result, setResult] = useState(false)
  return (
    <BatchManageLayout
      description="Manage test resources"
      filters={<input aria-label="Search test resources" />}
      controlsLabel="Test controls"
      visibleCount={selected === 0 ? 0 : 2}
      visibleSelectedCount={selected}
      selectedCount={selected}
      selectedOnly={false}
      busy={busy}
      onToggleAll={onToggleAll}
      onToggleSelectedOnly={() => {}}
      onClear={() => setSelected(0)}
      actions={
        <button data-batch-delete-trigger onClick={() => setReview(true)}>
          Review removal
        </button>
      }
      feedback={result ? <p role="status">Removed</p> : undefined}
      onDone={result ? () => setResult(false) : undefined}
      review={
        review ? (
          <BatchManageReview
            title="Review removal"
            description="Removal cannot be undone"
            summary="One removable resource"
            details="Resource details"
            busy={busy}
            onCancel={() => setReview(false)}
            actions={
              <button
                onClick={() => {
                  setReview(false)
                  setSelected(0)
                  setResult(true)
                }}
              >
                Confirm removal
              </button>
            }
          />
        ) : undefined
      }
    >
      <label>
        <input type="checkbox" />
        Test row
      </label>
    </BatchManageLayout>
  )
}

describe('BatchManageLayout', () => {
  it('presents mixed selection and returns focus when clearing hides the dock', () => {
    render(<Harness />)
    const selectAll = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select all results' })
    expect(selectAll.indeterminate).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(selectAll.indeterminate).toBe(false)
    expect(document.querySelector('[data-slot="batch-manage-dock"]')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('announces selection once and gives its icon-only clear control an accessible name', () => {
    render(<Harness />)
    expect(screen.getByRole('status').textContent).toBe('1 selected')
    expect(screen.getByRole('button', { name: 'Show selected' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
    expect(screen.getByRole('button', { name: 'Clear selection' }).textContent).toBe('')
    expect(
      document.querySelector('[data-slot="batch-dock-fade"]')?.getAttribute('aria-hidden')
    ).toBe('true')
  })

  it('focuses review, locks the list, and cancels Escape without propagating it', () => {
    const onEscape = vi.fn()
    render(
      <div onKeyDown={onEscape}>
        <Harness />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review removal' }))
    const title = screen.getByRole('heading', { name: 'Review removal' })
    expect(document.activeElement).toBe(title)
    expect(screen.getByRole('textbox').matches(':disabled')).toBe(true)
    expect(document.querySelector('details')?.open).toBe(false)
    fireEvent.keyDown(title, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="batch-manage-review"]')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Review removal' }))
    expect(screen.getByRole('textbox').matches(':disabled')).toBe(false)
  })

  it('keeps completion feedback after the last resource is removed and supports dismissal', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Review removal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }))
    expect(screen.getByRole('status').textContent).toBe('Removed')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
    expect(document.querySelector('[data-slot="batch-manage-dock"]')).toBeNull()
  })

  it('does not cancel a busy review with Escape', () => {
    const view = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Review removal' }))
    view.rerender(<Harness busy />)
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Review removal' }), { key: 'Escape' })
    expect(document.querySelector('[data-slot="batch-manage-review"]')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
  })
})
