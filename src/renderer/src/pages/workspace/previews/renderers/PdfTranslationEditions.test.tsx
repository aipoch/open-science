// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PdfTranslationEditions } from './PdfTranslationEditions'
import type { PdfTranslationEdition } from '../../../../../../shared/pdf-translation'
import { useSettingsStore } from '@/stores/settings-store'
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
const initialSettings = useSettingsStore.getState()
afterEach(() => {
  cleanup()
  useSettingsStore.setState(initialSettings)
})
const edition: PdfTranslationEdition = {
  id: 'first',
  key: 'checkpoint-1',
  language: 'Chinese',
  glossary: [{ source: 'cell', target: '细胞' }],
  concurrency: 4,
  model: {
    mode: 'agent',
    frameworkId: 'opencode',
    providerId: 'historical-provider',
    providerName: 'Historical provider',
    modelId: 'historical-model',
    reasoningEffort: 'high'
  },
  updatedAt: 1700000000000
}
it('shows saved parameters independently of the current Settings model', () => {
  useSettingsStore.setState({ activeModel: 'current-model', activeProviderId: 'current-provider' })
  render(
    <PdfTranslationEditions
      selectedKey={edition.key}
      editions={[edition]}
      onSelect={vi.fn()}
      onRetry={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Saved translation parameters' }))
  expect(screen.getByText('Historical provider')).toBeTruthy()
  expect(screen.getByText('historical-model')).toBeTruthy()
  expect(screen.getByText('opencode')).toBeTruthy()
  expect(screen.getByText('high')).toBeTruthy()
  expect(screen.getByText('4x')).toBeTruthy()
  expect(screen.getByText('cell → 细胞')).toBeTruthy()
  expect(screen.queryByText('current-model')).toBeNull()
  expect(screen.queryByText('current-provider')).toBeNull()
})
it('keeps multiple unselected editions available and disables switching with a reason', () => {
  const onSelect = vi.fn()
  const editions = [{ ...edition }, { ...edition, id: 'second', key: 'checkpoint-2' }]
  const props = { editions, onSelect, onRetry: vi.fn() }
  const { rerender } = render(<PdfTranslationEditions {...props} />)
  expect(screen.getByRole('combobox', { name: 'Saved translations' }).textContent).toContain(
    'Choose a saved translation'
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Saved translations' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: /^#2 Chinese/ }))
  expect(onSelect).toHaveBeenCalledWith('second')
  rerender(
    <PdfTranslationEditions
      {...props}
      disabledReason="Wait for text preparation to finish or cancel it."
    />
  )
  expect(
    screen.getByRole<HTMLButtonElement>('combobox', { name: 'Saved translations' }).disabled
  ).toBe(true)
  expect(
    screen.getByRole('group', { name: 'Wait for text preparation to finish or cancel it.' })
  ).toBeTruthy()
})
it('does not infer an unrecorded model from current settings', () => {
  useSettingsStore.setState({ activeModel: 'current-model' })
  render(
    <PdfTranslationEditions
      selectedKey={edition.key}
      editions={[{ ...edition, model: { frameworkId: 'opencode' } }]}
      onSelect={vi.fn()}
      onRetry={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Saved translation parameters' }))
  expect(screen.getByText('Not recorded')).toBeTruthy()
  expect(screen.getByText('Default')).toBeTruthy()
  expect(screen.queryByText('current-model')).toBeNull()
})

it('keeps saved details out of the sidebar until requested and closes them on selection changes', () => {
  const props = {
    selectedKey: edition.key,
    editions: [edition],
    onSelect: vi.fn(),
    onRetry: vi.fn()
  }
  const { rerender } = render(<PdfTranslationEditions {...props} />)
  const trigger = screen.getByRole('combobox', { name: 'Saved translations' })
  expect(trigger.textContent).toBe('#1 Chinese · historical-model')
  expect(screen.queryByText('Historical provider')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Saved translation parameters' }))
  expect(screen.getByRole('dialog', { name: 'Saved translation parameters' })).toBeTruthy()
  expect(screen.getByText('Historical provider')).toBeTruthy()
  rerender(
    <PdfTranslationEditions
      {...props}
      selectedKey="other-key"
      editions={[
        {
          ...edition,
          key: 'other-key',
          model: { frameworkId: 'direct-api', mode: 'api', modelId: 'other-model' }
        }
      ]}
    />
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Saved translation parameters' }))
  expect(screen.getByText('Direct API')).toBeTruthy()
  expect(screen.queryByText('direct-api')).toBeNull()
})

it('uses a matching configured provider name for older editions without exposing internal ids', () => {
  useSettingsStore.setState({
    providers: [{ id: 'historical-provider', name: 'MiniMax' }] as never
  })
  render(
    <PdfTranslationEditions
      selectedKey={edition.key}
      editions={[{ ...edition, model: { ...edition.model, providerName: undefined } }]}
      onSelect={vi.fn()}
      onRetry={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Saved translation parameters' }))
  expect(screen.getByText('MiniMax')).toBeTruthy()
  expect(screen.queryByText('historical-provider')).toBeNull()
})
it('requires confirmation before deleting and keeps the confirmation open for a retry after failure', async () => {
  const onDelete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  render(
    <PdfTranslationEditions
      selectedKey={edition.key}
      editions={[edition]}
      onSelect={vi.fn()}
      onRetry={vi.fn()}
      onDelete={onDelete}
    />
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Delete translation' }))
  expect(onDelete).not.toHaveBeenCalled()
  const dialog = screen.getByRole('alertdialog')
  expect(dialog.textContent).toContain('all entries for this PDF')
  fireEvent.click(dialog.querySelector('button:last-child')!)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not delete'))
  fireEvent.click(dialog.querySelector('button:last-child')!)
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(onDelete).toHaveBeenCalledTimes(2)
  expect(onDelete).toHaveBeenLastCalledWith('first')
})

it('allows deleting a saved edition when idle and blocks duplicate confirmations while deletion is pending', async () => {
  const pending = Promise.withResolvers<boolean>()
  const onDelete = vi.fn(() => pending.promise)
  const props = {
    selectedKey: edition.key,
    editions: [edition],
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    onDelete
  }
  const { rerender } = render(<PdfTranslationEditions {...props} />)
  const entry = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete translation' })
  expect(entry.disabled).toBe(false)
  fireEvent.click(entry)
  const confirm = screen
    .getByRole('alertdialog')
    .querySelector<HTMLButtonElement>('button:last-child')!
  expect(confirm.disabled).toBe(false)
  fireEvent.click(confirm)
  const waiting = screen.getByRole<HTMLButtonElement>('button', { name: 'Deleting…' })
  expect(waiting.disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
  fireEvent.click(waiting)
  rerender(<PdfTranslationEditions {...props} disabledReason="Loading…" />)
  await act(async () => pending.resolve(true))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(onDelete).toHaveBeenCalledOnce()
  expect(onDelete).toHaveBeenCalledWith(edition.id)
})
