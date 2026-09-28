// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Hash } from 'lucide-react'
import { ActionMenuProvider } from '@/components/action-menu'
import { JournalColumnHeader } from './JournalColumnHeader'
import type { JournalField } from '../../../../shared/journal-attributes'

afterEach(cleanup)
Element.prototype.scrollIntoView = vi.fn()
const field: JournalField = {
  id: 'signal',
  label: 'Signal',
  kind: 'number',
  visible: true,
  colors: {}
}
const menu = async (action: string): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: 'Column actions for Signal' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: action }))
}
it('provides directional sorting, hiding and a cancellable anchored column editor', async () => {
  const onSort = vi.fn()
  const onHide = vi.fn(async () => {})
  const onSave = vi.fn(async () => undefined)
  render(
    <ActionMenuProvider>
      <JournalColumnHeader
        identity="dataset:signal"
        label="Signal"
        icon={Hash}
        field={field}
        disabled={false}
        onSort={onSort}
        onHide={onHide}
        onSave={onSave}
      />
    </ActionMenuProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Signal' }))
  expect(onSort).toHaveBeenLastCalledWith(false)
  await menu('Sort descending')
  await waitFor(() => expect(onSort).toHaveBeenLastCalledWith(true))
  await menu('Sort ascending')
  await waitFor(() => expect(onSort).toHaveBeenLastCalledWith(false))
  await menu('Edit column')
  fireEvent.change(await screen.findByRole('textbox', { name: 'Attribute name' }), {
    target: { value: 'Unsaved' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onSave).not.toHaveBeenCalled()
  await menu('Edit column')
  expect(
    ((await screen.findByRole('textbox', { name: 'Attribute name' })) as HTMLInputElement).value
  ).toBe('Signal')
  fireEvent.change(screen.getByLabelText('Attribute name'), {
    target: { value: '  Renamed signal  ' }
  })
  fireEvent.click(screen.getByRole('combobox', { name: 'Attribute type' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Text' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith({ ...field, label: 'Renamed signal', kind: 'text' })
  )
  await waitFor(() => expect(screen.queryByLabelText('Attribute name')).toBeNull())
  await menu('Hide column')
  await waitFor(() => expect(onHide).toHaveBeenCalledOnce())
})
it('keeps an invalid type edit open with a local explanation', async () => {
  const onSave = vi.fn(async () => 'Invalid synthetic type change')
  render(
    <ActionMenuProvider>
      <JournalColumnHeader
        identity="dataset:signal"
        label="Signal"
        icon={Hash}
        field={field}
        disabled={false}
        onSort={vi.fn()}
        onHide={vi.fn()}
        onSave={onSave}
      />
    </ActionMenuProvider>
  )
  await menu('Edit column')
  fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Invalid synthetic type change'
  )
  expect(screen.getByLabelText('Attribute name')).toBeTruthy()
})
