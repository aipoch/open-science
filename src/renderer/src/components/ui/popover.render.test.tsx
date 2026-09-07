// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Select, SelectContent, SelectItem, SelectTrigger } from './select'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => undefined

afterEach(cleanup)

const renderPopover = (menu = false): void => {
  render(
    <Popover>
      <PopoverTrigger>Filters</PopoverTrigger>
      <PopoverContent>
        {menu ? (
          <DropdownMenu>
            <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Update</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Select defaultValue="all">
            <SelectTrigger aria-label="Tags">Tags</SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        )}
        <input aria-label="Year" />
      </PopoverContent>
    </Popover>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
}

const outsideGesture = async (): Promise<void> => {
  // A modal child sets pointer-events:none on the parent, so the second trigger
  // click actually targets HTML. Include click: Radix defers outside dismissal.
  await act(async () => {
    fireEvent.pointerDown(document.documentElement, { button: 0 })
    fireEvent.pointerUp(document.documentElement, { button: 0 })
    fireEvent.click(document.documentElement, { button: 0 })
  })
}

it('dismisses only the select on repeated trigger clicks, then allows normal outside dismissal', async () => {
  renderPopover()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    fireEvent.click(screen.getByRole('combobox', { name: 'Tags' }))
    await screen.findByRole('option', { name: 'All' })
    // Let Radix install its outside-pointer listener after mounting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await outsideGesture()
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(screen.getByRole('textbox', { name: 'Year' })).not.toBeNull()
  }
  await outsideGesture()
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Year' })).toBeNull())
})

it('protects a parent popover when a nested dropdown menu is dismissed', async () => {
  renderPopover(true)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Actions' }), { key: 'Enter' })
  await screen.findByRole('menuitem', { name: 'Update' })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await outsideGesture()
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(screen.getByRole('textbox', { name: 'Year' })).not.toBeNull()
})

it('preserves selection and closes one layer at a time with Escape, restoring focus', async () => {
  renderPopover()
  fireEvent.click(screen.getByRole('combobox', { name: 'Tags' }))
  fireEvent.click(await screen.findByRole('option', { name: 'All' }))
  expect(screen.getByRole('textbox', { name: 'Year' })).not.toBeNull()
  fireEvent.click(screen.getByRole('combobox', { name: 'Tags' }))
  await screen.findByRole('listbox')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Tags' }))
  )
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Year' })).toBeNull())
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Filters' }))
  )
})
