// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { JournalAlignment } from './JournalAlignment'
import { JournalAttributes } from '../JournalAttributes'
import { literatureItemInputSchema } from '../../../../../shared/literature'
import type { JournalResult, JournalRequest } from '../../../../../shared/journal-attributes'

afterEach(cleanup)
const report: NonNullable<JournalResult['alignment']> = {
  token: '11111111-1111-4111-8111-111111111111',
  counts: { matched: 20, missing: 51, ambiguous: 1 },
  total: 51,
  rows: [
    {
      itemId: 'fictional-reference',
      metadataRevision: 1,
      bindingRevision: null,
      title: 'Invented reference',
      identity: { name: 'Imaginary Moonlight Review', aliases: [], issns: [] },
      status: 'missing',
      reason: 'not-found',
      candidates: [],
      candidateTotal: 0
    }
  ]
}
it('opens an expanded alignment panel without starting a scan', () => {
  const journals = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { journals } }
  })
  render(<JournalAlignment expanded onOpenItem={() => {}} />)
  expect(screen.getByRole('button', { name: 'Check library' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Journal alignment' })).toBeNull()
  expect(screen.getByText('Check journal matches')).toBeTruthy()
  expect(
    screen.getByText(
      'Find unmatched or ambiguous references. This check does not change your library.'
    )
  ).toBeTruthy()
  expect(journals).not.toHaveBeenCalled()
})

it('checks and pages the library, keeps candidates read-only and invalidates after a change', async () => {
  let changed!: () => void
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'audit-step')
      return { scan: { token: report.token, processed: 72, done: true } }
    if (request.action === 'candidates')
      return {
        candidates: [
          { id: 'invented-candidate', name: 'Imaginary Moonlight Review', aliases: [], issns: [] }
        ]
      }
    return {
      alignment: {
        ...report,
        rows: request.action === 'audit' && request.offset ? [] : report.rows
      }
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals,
        onChanged: (callback: () => void) => {
          changed = callback
          return () => {}
        }
      }
    }
  })
  const onOpenItem = vi.fn()
  render(<JournalAlignment onOpenItem={onOpenItem} />)
  fireEvent.click(screen.getByRole('button', { name: 'Journal alignment' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  await screen.findByText('Matched: 20 · Unmatched: 51 · Conflicts: 1')
  expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy()
  const candidateAction = screen.getByRole('button', { name: 'Find journal candidates' })
  const actionCell = candidateAction.closest('td')!
  expect(actionCell.cellIndex).toBe(3)
  expect(actionCell.textContent).not.toContain('No matching journal')
  expect(candidateAction.querySelector('svg')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Invented reference' }))
  expect(onOpenItem).toHaveBeenCalledWith(
    'fictional-reference',
    screen.getByRole('button', { name: 'Invented reference' })
  )
  fireEvent.click(screen.getAllByRole('button', { name: 'Find journal candidates' })[0])
  await waitFor(() =>
    expect(journals).toHaveBeenCalledWith({
      action: 'candidates',
      query: 'Imaginary Moonlight Review'
    })
  )
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  await waitFor(() =>
    expect(journals).toHaveBeenCalledWith({
      action: 'audit',
      token: report.token,
      status: 'missing',
      offset: 25,
      limit: 25
    })
  )
  await screen.findByText('No references in this group.')
  act(() => changed())
  expect(
    screen.getByText(
      'References or journal data may have changed. Recheck the library before using these results.'
    )
  ).toBeTruthy()
  expect(
    (screen.getByRole('combobox', { name: 'Match status' }) as HTMLSelectElement).disabled
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Recheck library' }))
  await waitFor(() =>
    expect(
      (screen.getByRole('combobox', { name: 'Match status' }) as HTMLSelectElement).disabled
    ).toBe(false)
  )
  expect(
    journals.mock.calls.every(([request]) =>
      ['audit', 'audit-step', 'candidates'].includes(request.action)
    )
  ).toBe(true)
})

it('discards a late check after closing and recovers from an expired result', async () => {
  let resolve!: (result: JournalResult) => void
  let starts = 0
  const journals = vi.fn((request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'audit-step') {
      starts++
      if (starts === 1)
        return new Promise((done) => {
          resolve = done
        })
      if (starts === 2) return Promise.reject(new Error('expired'))
      return Promise.resolve({ scan: { token: report.token, processed: 72, done: true } })
    }
    return Promise.resolve(request.action === 'audit-cancel' ? {} : { alignment: report })
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalAlignment onOpenItem={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Journal alignment' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  fireEvent.click(screen.getByRole('button', { name: 'Journal alignment' }))
  await act(async () => resolve({ scan: { token: report.token, processed: 500, done: false } }))
  fireEvent.click(screen.getByRole('button', { name: 'Journal alignment' }))
  expect(screen.queryByText('Invented reference')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  await screen.findByText('Could not check journal alignment. Check the library again.')
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  await screen.findByText('Invented reference')
})

it('requires an explicit reference and reviewed journal before persisting a confirmation', async () => {
  let confirmed = false
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'audit-step')
      return { scan: { token: report.token, processed: 72, done: true } }
    if (request.action === 'candidates')
      return {
        candidates: [
          { id: 'chosen', name: 'Imaginary Moonlight Review', aliases: [], issns: ['1234-5679'] }
        ]
      }
    if (request.action === 'bind') {
      confirmed = true
      return {}
    }
    if (request.action === 'list') return { datasets: [] }
    if (request.action === 'resolve')
      return {
        matches: request.identities.map(() => ({
          status: confirmed ? 'matched' : 'missing',
          attributes: confirmed
            ? [
                {
                  key: 'synthetic:signal',
                  label: 'Signal',
                  kind: 'text',
                  value: 'Saved confirmation attribute',
                  source: 'Synthetic',
                  year: 2031,
                  colors: {}
                }
              ]
            : []
        }))
      }
    return { alignment: report }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(
    <>
      <JournalAttributes
        itemId="fictional-reference"
        item={literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'Invented reference',
          containerTitle: 'Imaginary Moonlight Review'
        })}
        detail
      />
      <JournalAlignment onOpenItem={() => {}} />
    </>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Journal alignment' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  await screen.findByText('Invented reference')
  fireEvent.click(screen.getAllByRole('button', { name: 'Find journal candidates' })[0])
  fireEvent.click(await screen.findByRole('button', { name: 'Choose journal' }))
  expect(journals.mock.calls.some(([request]) => request.action === 'bind')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm journal association' }))
  await waitFor(() =>
    expect(journals).toHaveBeenCalledWith({
      action: 'bind',
      token: report.token,
      itemId: 'fictional-reference',
      journalId: 'chosen',
      expectedMetadataRevision: 1,
      expectedBindingRevision: null
    })
  )
  await screen.findByText(
    'References or journal data may have changed. Recheck the library before using these results.'
  )
  expect(screen.queryByRole('button', { name: 'Confirm journal association' })).toBeNull()
  await screen.findByText('Saved confirmation attribute')
})

it('shows scan progress and cancels without accepting a late page', async () => {
  let finish!: (result: JournalResult) => void
  let steps = 0
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action !== 'audit-step') return {}
    if (++steps === 1) return { scan: { token: report.token, processed: 500, done: false } }
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalAlignment onOpenItem={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Journal alignment' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  await screen.findByText('References checked: 500')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(journals).toHaveBeenCalledWith({ action: 'audit-cancel', token: report.token })
  await act(async () => finish({ scan: { token: report.token, processed: 501, done: true } }))
  expect(screen.queryByText('Invented reference')).toBeNull()
  expect(screen.queryByText('References checked: 501')).toBeNull()
  expect(journals.mock.calls.some(([request]) => request.action === 'audit')).toBe(false)
})

it('starts a fresh scan after a later batch fails instead of reusing its expired token', async () => {
  let steps = 0
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'audit-step') {
      steps++
      if (steps === 1) return { scan: { token: report.token, processed: 500, done: false } }
      if (steps === 2) throw new Error('expired')
      expect(request.token).toBeUndefined()
      return { scan: { token: report.token, processed: 72, done: true } }
    }
    return request.action === 'audit' ? { alignment: report } : {}
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalAlignment onOpenItem={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Journal alignment' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  await screen.findByText('Could not check journal alignment. Check the library again.')
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  await screen.findByText('Invented reference')
  expect(steps).toBe(3)
})

it('switches status within one scan and confines loading and empty states to a stable table viewport', async () => {
  let finish!: (result: JournalResult) => void
  let pages = 0
  const journals = vi.fn((request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'audit-step')
      return Promise.resolve({ scan: { token: report.token, processed: 72, done: true } })
    if (request.action === 'audit' && ++pages > 1)
      return new Promise((resolve) => {
        finish = resolve
      })
    return Promise.resolve({ alignment: structuredClone(report) })
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  Element.prototype.scrollIntoView = vi.fn()
  render(<JournalAlignment expanded onOpenItem={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  const summary = await screen.findByText('Matched: 20 · Unmatched: 51 · Conflicts: 1')
  const requestsBeforeFocus = journals.mock.calls.length
  fireEvent(window, new Event('focus'))
  expect(journals).toHaveBeenCalledTimes(requestsBeforeFocus)
  expect(
    (screen.getByRole('combobox', { name: 'Match status' }) as HTMLButtonElement).disabled
  ).toBe(false)
  expect(
    screen.queryByText(
      'References or journal data may have changed. Recheck the library before using these results.'
    )
  ).toBeNull()
  const siblings = summary.parentElement!.childElementCount
  const viewport = screen.getByRole('table').parentElement!
  const footer = screen.getByRole('combobox', { name: 'References per page' }).closest('fieldset')
  expect(viewport.className).toContain('h-full')
  expect(viewport.parentElement!.className).toContain('h-[min(24rem,45dvh)]')
  viewport.scrollTop = 200
  fireEvent.click(screen.getByRole('combobox', { name: 'Match status' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Matched' }))
  expect(journals).toHaveBeenLastCalledWith({
    action: 'audit',
    token: report.token,
    status: 'matched',
    offset: 0,
    limit: 25
  })
  expect(journals.mock.calls.filter(([request]) => request.action === 'audit-step')).toHaveLength(1)
  expect(screen.getByText('Matched: 20 · Unmatched: 51 · Conflicts: 1')).toBe(summary)
  expect(summary.parentElement!.childElementCount).toBe(siblings)
  expect(screen.queryByText('Checking…')).toBeNull()
  expect(viewport.parentElement!.getAttribute('aria-busy')).toBe('true')
  expect(viewport.parentElement!.contains(screen.getByText('Loading'))).toBe(true)
  fireEvent(window, new Event('focus'))
  await act(async () => finish({ alignment: { ...report, total: 0, rows: [] } }))
  expect(
    (screen.getByRole('combobox', { name: 'Match status' }) as HTMLButtonElement).disabled
  ).toBe(false)
  expect(viewport.contains(screen.getByText('No references in this group.'))).toBe(true)
  expect(viewport.parentElement!.getAttribute('aria-busy')).toBe('false')
  expect(viewport.scrollTop).toBe(0)
  expect(screen.getByRole('combobox', { name: 'References per page' }).closest('fieldset')).toBe(
    footer
  )
  expect(summary.parentElement!.childElementCount).toBe(siblings)
})

it('changes page size using the existing scan and shows candidates only for a selected reference', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'audit-step')
      return { scan: { token: report.token, processed: 72, done: true } }
    if (request.action === 'candidates') return { candidates: [] }
    return { alignment: structuredClone(report) }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalAlignment expanded onOpenItem={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  await screen.findByText('Matched: 20 · Unmatched: 51 · Conflicts: 1')
  expect(screen.queryByRole('textbox', { name: 'Search journal candidates' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))
  await waitFor(() =>
    expect(journals).toHaveBeenLastCalledWith({
      action: 'audit',
      token: report.token,
      status: 'missing',
      offset: 25,
      limit: 25
    })
  )
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'References per page' }).matches(':disabled')).toBe(
      false
    )
  )
  fireEvent.click(screen.getByRole('combobox', { name: 'References per page' }))
  fireEvent.click(await screen.findByRole('option', { name: '100' }))
  await waitFor(() =>
    expect(journals).toHaveBeenLastCalledWith({
      action: 'audit',
      token: report.token,
      status: 'missing',
      offset: 0,
      limit: 100
    })
  )
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'References per page' }).textContent).toBe('100')
  )
  expect(journals.mock.calls.filter(([request]) => request.action === 'audit-step')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Find journal candidates' }))
  expect(
    (screen.getByRole('textbox', { name: 'Search journal candidates' }) as HTMLInputElement).value
  ).toBe('Imaginary Moonlight Review')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Close' }).matches(':disabled')).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('textbox', { name: 'Search journal candidates' })).toBeNull()
})

it('shows recheck progress inside the existing table without adding layout rows', async () => {
  let completeScan!: (value: JournalResult) => void
  let scans = 0
  const journals = vi.fn((request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'audit-step') {
      if (++scans > 1)
        return new Promise((resolve) => {
          completeScan = resolve
        })
      return Promise.resolve({ scan: { token: report.token, processed: 72, done: true } })
    }
    return Promise.resolve({ alignment: structuredClone(report) })
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalAlignment expanded onOpenItem={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check library' }))
  await screen.findByText('Invented reference')
  const table = screen.getByRole('table')
  const viewport = table.parentElement!.parentElement!
  const layout = viewport.parentElement!
  const childCount = layout.childElementCount
  fireEvent.click(screen.getByRole('button', { name: 'Recheck library' }))
  expect(screen.getByRole('table')).toBe(table)
  expect(viewport.contains(screen.getByText('References checked: 0'))).toBe(true)
  expect(layout.childElementCount).toBe(childCount)
  expect(viewport.getAttribute('aria-busy')).toBe('true')
  await act(async () => completeScan({ scan: { token: report.token, processed: 72, done: true } }))
  expect(layout.childElementCount).toBe(childCount)
  expect(viewport.getAttribute('aria-busy')).toBe('false')
})
