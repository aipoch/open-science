import * as AlertDialog from './alert-dialog'
import { OverlayLayerProvider } from './overlay-layer'
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as Dialog from '@/components/ui/dialog'
import { LiteratureDuplicatePolicyField } from '@/pages/literature/imports/LiteratureDuplicatePolicyField'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './dropdown-menu'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => undefined
afterEach(cleanup)

const renderDialog = (menu = false): void => {
  render(
    <Dialog.Root defaultOpen>
      <Dialog.Portal>
        <Dialog.Overlay data-testid="overlay" />
        <Dialog.Content>
          <Dialog.Title>Import references</Dialog.Title>
          <Dialog.Description>Review references</Dialog.Description>
          {menu ? (
            <DropdownMenu>
              <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>Update</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <LiteratureDuplicatePolicyField value="reuse" onChange={() => {}} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const outsideGesture = async (): Promise<void> => {
  // The modal Select disables its parent content's pointer events, so a second
  // click at the trigger hits the Dialog overlay instead.
  await act(async () => {
    fireEvent.pointerDown(screen.getByTestId('overlay'), { button: 0 })
    fireEvent.pointerUp(screen.getByTestId('overlay'), { button: 0 })
    fireEvent.click(screen.getByTestId('overlay'), { button: 0 })
  })
}

it.each([false, true])(
  'dismisses only the child on repeated trigger clicks, then allows normal backdrop dismissal (menu=%s)',
  async (menu) => {
    renderDialog(menu)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (menu) fireEvent.keyDown(screen.getByRole('button', { name: 'Actions' }), { key: 'Enter' })
      else fireEvent.click(screen.getByRole('combobox'))
      await screen.findByRole(menu ? 'menu' : 'listbox')
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      await outsideGesture()
      await waitFor(() => expect(screen.queryByRole(menu ? 'menu' : 'listbox')).toBeNull())
      expect(screen.queryByRole('dialog')).not.toBeNull()
    }
    await outsideGesture()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }
)

it('preserves option selection and dismisses one layer at a time with Escape and focus return', async () => {
  renderDialog()
  const trigger = screen.getByRole('combobox')
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('option', { name: 'Keep as separate reference' }))
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  expect(screen.queryByRole('dialog')).not.toBeNull()
  fireEvent.click(trigger)
  await screen.findByRole('listbox')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  expect(screen.queryByRole('dialog')).not.toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('forwards content refs and preserves stricter caller dismissal policies', async () => {
  const cleanupRef = vi.fn()
  const ref = vi.fn(() => cleanupRef)
  const onInteractOutside = vi.fn((event: { preventDefault: () => void }) => event.preventDefault())
  const view = render(
    <Dialog.Root defaultOpen>
      <Dialog.Portal>
        <Dialog.Overlay data-testid="overlay" />
        <Dialog.Content ref={ref} onInteractOutside={onInteractOutside}>
          <Dialog.Title>Keep open</Dialog.Title>
          <Dialog.Description>Explicit close required</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
  expect(ref).toHaveBeenCalledWith(screen.getByRole('dialog'))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await outsideGesture()
  expect(onInteractOutside).toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeNull()
  view.unmount()
  expect(cleanupRef).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'ignores composing Escape before caller effects and preserves ordinary Escape policy (custom=%s)',
  (custom) => {
    const onEscapeKeyDown = vi.fn((event: KeyboardEvent) => event.preventDefault())
    render(
      <Dialog.Root defaultOpen>
        <Dialog.Content onEscapeKeyDown={custom ? onEscapeKeyDown : undefined}>
          <Dialog.Title>Edit reference</Dialog.Title>
          <Dialog.Description>Unsaved draft</Dialog.Description>
          <input aria-label="Draft" defaultValue="Existing draft" />
        </Dialog.Content>
      </Dialog.Root>
    )
    const dialog = screen.getByRole('dialog')
    const input = screen.getByRole('textbox', { name: 'Draft' })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    expect(onEscapeKeyDown).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBe(dialog)
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Escape', isComposing: false })
    if (custom) {
      expect(onEscapeKeyDown).toHaveBeenCalledOnce()
      expect(screen.queryByRole('dialog')).toBe(dialog)
    } else {
      expect(screen.queryByRole('dialog')).toBeNull()
    }
  }
)

it('inherits expanded surface layers through portals and raises child menus above their dialog', async () => {
  render(
    <OverlayLayerProvider value={60}>
      <Dialog.Root defaultOpen>
        <Dialog.Portal>
          <Dialog.Overlay data-testid="layer-overlay" />
          <Dialog.Content data-testid="layer-dialog">
            <Dialog.Title>Layered question</Dialog.Title>
            <Dialog.Description>Choose an action</Dialog.Description>
            <DropdownMenu>
              <DropdownMenuTrigger>Layer actions</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>Layer item</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </OverlayLayerProvider>
  )
  expect(screen.getByTestId('layer-overlay').style.zIndex).toBe('80')
  expect(screen.getByTestId('layer-dialog').style.zIndex).toBe('80')
  fireEvent.keyDown(screen.getByRole('button', { name: 'Layer actions' }), { key: 'Enter' })
  await waitFor(() => expect(screen.getByRole('menu').style.zIndex).toBe('90'))
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(screen.getByRole('dialog', { name: 'Layered question' })).toBeTruthy()
})

it('raises a confirmation above the dialog that opened it', () => {
  render(
    <Dialog.Root defaultOpen>
      <Dialog.Portal>
        <Dialog.Content data-testid="parent-dialog">
          <Dialog.Title>Parent</Dialog.Title>
          <Dialog.Description>Parent description</Dialog.Description>
          <AlertDialog.Root defaultOpen>
            <AlertDialog.Portal>
              <AlertDialog.Overlay data-testid="confirmation-overlay" />
              <AlertDialog.Content data-testid="confirmation">
                <AlertDialog.Title>Confirm</AlertDialog.Title>
                <AlertDialog.Description>Confirm description</AlertDialog.Description>
                <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
                <AlertDialog.Action>Confirm</AlertDialog.Action>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
  expect(screen.getByTestId('parent-dialog').style.zIndex).toBe('60')
  expect(screen.getByTestId('confirmation-overlay').style.zIndex).toBe('80')
  expect(screen.getByTestId('confirmation').style.zIndex).toBe('80')
})
