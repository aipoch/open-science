// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PdfTranslationPreparation } from './PdfTranslationPreparation'
import type { PdfPreparationState } from './use-pdf-translation-preparation'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
it('shows actual progress and lets the user cancel or retry a failed read', () => {
  const props = { pageCount: 2, onStart: vi.fn(), onCancel: vi.fn(), onNavigate: vi.fn() }
  const { rerender } = render(
    <PdfTranslationPreparation {...props} state={{ status: 'running', pagesRead: 1 }} />
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(props.onCancel).toHaveBeenCalledOnce()
  rerender(<PdfTranslationPreparation {...props} state={{ status: 'error' }} />)
  expect(screen.getByRole('alert').textContent).toContain('Could not prepare full text')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(props.onStart).toHaveBeenCalledOnce()
})

it('keeps saved translation recovery compact while it resumes', () => {
  const props = { pageCount: 2, onStart: vi.fn(), onCancel: vi.fn(), onNavigate: vi.fn() }
  render(
    <PdfTranslationPreparation {...props} compact state={{ status: 'running', pagesRead: 1 }} />
  )
  expect(screen.getByRole('status').textContent).toBe('Loading saved translation…')
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
})

it('keeps recovery compact before preparation starts', () => {
  const props = { pageCount: 2, onStart: vi.fn(), onCancel: vi.fn(), onNavigate: vi.fn() }
  render(<PdfTranslationPreparation {...props} compact state={{ status: 'idle' }} />)
  expect(screen.getByRole('status').textContent).toBe('Loading saved translation…')
  expect(screen.queryByRole('button', { name: 'Full-text preparation' })).toBeNull()
})

it('uses the same full-width step layout before preparation starts', () => {
  const onStart = vi.fn()
  const props = { pageCount: 2, onStart, onCancel: vi.fn(), onNavigate: vi.fn() }
  render(<PdfTranslationPreparation {...props} state={{ status: 'idle' }} />)
  const step = screen.getByRole('button', { name: 'Full-text preparation' })
  expect(step.className).toContain('flex-1')
  const prepare = screen.getByRole('button', { name: 'Prepare full text' })
  expect(prepare.className).toContain('w-full')
  fireEvent.click(prepare)
  expect(onStart).toHaveBeenCalledOnce()
})

it('links empty and excluded pages back to the original without presenting them as translated', () => {
  vi.useFakeTimers()
  const props = { pageCount: 2, onStart: vi.fn(), onCancel: vi.fn(), onNavigate: vi.fn() }
  const state: PdfPreparationState = {
    status: 'ready',
    extraction: {
      source: { units: [] } as never,
      coverage: {
        pageCount: 2,
        textItemCount: 3,
        includedItemCount: 1,
        excludedItemCount: 2,
        pagesWithoutText: [2],
        warnings: [],
        exclusions: [
          { reason: 'outside-page', items: [{ pageNumber: 1, index: 0, text: 'Outside' }] },
          { reason: 'invalid-geometry', items: [{ pageNumber: 1, index: 1, text: 'Invalid' }] }
        ]
      }
    }
  }
  render(<PdfTranslationPreparation {...props} state={state} />)
  const trigger = screen.getByText('Full-text preparation').closest('button')!
  const details = trigger.closest('[data-state]')!
  expect(details.getAttribute('data-state')).toBe('closed')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByText('Pages without extractable text'))
  fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))
  fireEvent.click(screen.getByText('Excluded text'))
  fireEvent.click(screen.getByRole('button', { name: 'Page 1' }))
  expect(props.onNavigate.mock.calls).toEqual([[2], [1]])
  const info = document.querySelector<HTMLElement>('[data-pdf-preparation-info]')!
  fireEvent.focus(info)
  return act(async () => {
    await vi.advanceTimersByTimeAsync(100)
    expect(document.body.textContent).toContain(
      'This report checks source coverage, not translation completeness or accuracy.'
    )
    vi.useRealTimers()
  })
})

it('keeps standalone source coverage details behind a focused tip', () => {
  vi.useFakeTimers()
  const props = { pageCount: 2, onStart: vi.fn(), onCancel: vi.fn(), onNavigate: vi.fn() }
  const state: PdfPreparationState = {
    status: 'ready',
    extraction: {
      source: {
        units: [
          {
            sourceOnly: true,
            fragments: [
              {
                pageNumber: 2,
                items: [
                  { index: 0, text: 'Cell' },
                  { index: 1, text: 'text' }
                ]
              }
            ]
          }
        ]
      } as never,
      coverage: {
        pageCount: 2,
        textItemCount: 2,
        includedItemCount: 2,
        excludedItemCount: 0,
        pagesWithoutText: [],
        warnings: [],
        exclusions: []
      }
    }
  }
  render(<PdfTranslationPreparation {...props} state={state} />)
  fireEvent.click(screen.getByText('Full-text preparation').closest('button')!)
  expect(
    screen.queryByText(
      'These text fragments are included in the located total. They remain in the original and are not translated as paragraphs.'
    )
  ).toBeNull()
  const info = document.querySelector<HTMLElement>('[data-pdf-independent-info]')!
  fireEvent.focus(info)
  return act(async () => {
    await vi.advanceTimersByTimeAsync(100)
    expect(document.body.textContent).toContain(
      'These text fragments are included in the located total. They remain in the original and are not translated as paragraphs.'
    )
    vi.useRealTimers()
  })
})

it.each([2, 120])('keeps original-layout navigation compact for %i pages', (pages) => {
  const props = { pageCount: pages, onStart: vi.fn(), onCancel: vi.fn(), onNavigate: vi.fn() }
  const state: PdfPreparationState = {
    status: 'ready',
    extraction: {
      source: {
        units: Array.from({ length: pages }, (_, index) => ({
          sourceOnly: true,
          fragments: [
            {
              pageNumber: index + 1,
              items: [
                { index: 0, text: 'Cell' },
                { index: 1, text: 'text' }
              ]
            }
          ]
        }))
      } as never,
      coverage: {
        pageCount: pages,
        textItemCount: pages * 2,
        includedItemCount: pages * 2,
        excludedItemCount: 0,
        pagesWithoutText: [],
        warnings: [],
        exclusions: []
      }
    }
  }
  render(<PdfTranslationPreparation {...props} state={state} />)
  fireEvent.click(screen.getByText('Full-text preparation').closest('button')!)
  expect(screen.getByText('Located separately').nextElementSibling?.textContent).toBe(
    String(pages * 2)
  )
  const navigation = screen.getByRole('combobox', { name: 'Original-layout pages' })
  expect(navigation.textContent).toContain(String(pages))
  expect(screen.queryByRole('button', { name: `Page ${pages}` })).toBeNull()
  expect(screen.queryByRole('option')).toBeNull()
  fireEvent.keyDown(navigation, { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name: `Page ${pages}` }))
  expect(props.onNavigate).toHaveBeenCalledWith(pages)
  expect(screen.queryByRole('option')).toBeNull()
})
