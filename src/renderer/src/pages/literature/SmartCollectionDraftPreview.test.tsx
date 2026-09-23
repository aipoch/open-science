// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SmartCollectionDraftPreview } from './SmartCollectionDraftPreview'
import { formatSmartRule } from './smart-rule-fields'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('retries the same draft and lets the user stop preview while the draft is invalid', async () => {
  vi.useFakeTimers()
  let attempts = 0
  const transact = vi.fn(async (command) => {
    if (command.kind !== 'preview-smart-collection') return {}
    if (++attempts === 1) throw new Error('Temporary failure')
    return { smartPreview: { configured: true, rows: [], inputTokens: 0, outputTokens: 0 } }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
  const props = {
    description: formatSmartRule({ description: '', inclusion: 'Adult trials', exclusion: '' }),
    evidenceMode: 'abstract' as const,
    scope: { kind: 'library' as const },
    disabled: false
  }
  const view = render(<SmartCollectionDraftPreview {...props} />)
  fireEvent.click(screen.getByRole('switch', { name: 'Live rule preview' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
  expect(attempts).toBe(2)
  const calls = transact.mock.calls.filter(
    ([command]) => command.kind === 'preview-smart-collection'
  )
  expect(calls[0][0].description).toBe(calls[1][0].description)
  expect(calls[0][0].requestId).not.toBe(calls[1][0].requestId)
  expect(screen.getByText('No references found')).toBeTruthy()
  view.rerender(<SmartCollectionDraftPreview {...props} description="" disabled />)
  const toggle = screen.getByRole('switch', { name: 'Live rule preview' })
  expect(toggle.hasAttribute('disabled')).toBe(false)
  fireEvent.click(toggle)
  view.rerender(<SmartCollectionDraftPreview {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(attempts).toBe(2)
})
