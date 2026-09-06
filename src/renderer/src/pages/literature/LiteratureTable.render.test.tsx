// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LiteratureTable, LiteratureTextTooltip } from './LiteratureTable'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('uses a consistent short delay and white-on-black contrast for long text hints', async () => {
  vi.useFakeTimers()
  render(
    <LiteratureTable>
      <tbody>
        <tr>
          <td>
            <LiteratureTextTooltip text="Complete reference title">
              <button>Reference title</button>
            </LiteratureTextTooltip>
          </td>
        </tr>
      </tbody>
    </LiteratureTable>
  )
  const trigger = screen.getByRole('button', { name: 'Reference title' })
  expect(trigger.hasAttribute('title')).toBe(false)
  fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
  await act(async () => {
    vi.advanceTimersByTime(299)
  })
  expect(screen.queryByRole('tooltip')).toBeNull()
  await act(async () => {
    vi.advanceTimersByTime(1)
  })
  expect(screen.getByRole('tooltip').textContent).toBe('Complete reference title')
  const content = document.querySelector('[data-slot="tooltip-content"]')
  expect(content?.className).toContain('bg-black')
  expect(content?.className).toContain('text-white')
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('shows hints on keyboard focus without waiting for hover', () => {
  render(
    <LiteratureTable>
      <tbody>
        <tr>
          <LiteratureTextTooltip text="Full abstract">
            <td tabIndex={0}>Short abstract</td>
          </LiteratureTextTooltip>
        </tr>
      </tbody>
    </LiteratureTable>
  )
  fireEvent.focus(screen.getByText('Short abstract'))
  expect(screen.getByRole('tooltip').textContent).toBe('Full abstract')
})
