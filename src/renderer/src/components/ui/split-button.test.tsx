// @vitest-environment jsdom
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  SplitButton,
  SplitButtonGroup,
  SplitButtonPrimary,
  SplitButtonTrigger,
  SplitButtonContent
} from './split-button'
import { DropdownMenuItem } from './dropdown-menu'

afterEach(cleanup)

it('honors React callback-ref cleanup on the group and trigger', () => {
  const groupCleanup = vi.fn()
  const triggerCleanup = vi.fn()
  const { unmount } = render(
    <SplitButton>
      <SplitButtonGroup ref={() => groupCleanup}>
        <SplitButtonPrimary>Send</SplitButtonPrimary>
        <SplitButtonTrigger ref={() => triggerCleanup} aria-label="Options">
          v
        </SplitButtonTrigger>
      </SplitButtonGroup>
    </SplitButton>
  )
  unmount()
  expect(groupCleanup).toHaveBeenCalledOnce()
  expect(triggerCleanup).toHaveBeenCalledOnce()
})

it('keeps the menu available when only the primary action is disabled and restores focus', async () => {
  const action = vi.fn()
  render(
    <SplitButton>
      <SplitButtonGroup>
        <SplitButtonPrimary disabled onClick={action}>
          Send
        </SplitButtonPrimary>
        <SplitButtonTrigger aria-label="Options">v</SplitButtonTrigger>
      </SplitButtonGroup>
      <SplitButtonContent>
        <DropdownMenuItem onSelect={action}>Plan</DropdownMenuItem>
      </SplitButtonContent>
    </SplitButton>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(action).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Options' }), { key: 'ArrowDown' })
  expect(await screen.findByRole('menuitem', { name: 'Plan' })).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(action).not.toHaveBeenCalled()
})

it('preserves asChild events and refs and supports controlled popovers', () => {
  const ref = createRef<HTMLButtonElement>()
  const action = vi.fn()
  const change = vi.fn()
  render(
    <SplitButton kind="popover" open onOpenChange={change}>
      <SplitButtonGroup>
        <SplitButtonPrimary asChild ref={ref}>
          <button onClick={action}>Apply</button>
        </SplitButtonPrimary>
        <SplitButtonTrigger aria-label="Styles">v</SplitButtonTrigger>
      </SplitButtonGroup>
      <SplitButtonContent aria-label="Style panel">
        <input aria-label="Search" />
      </SplitButtonContent>
    </SplitButton>
  )
  expect(ref.current).toBe(screen.getByRole('button', { name: 'Apply' }))
  fireEvent.click(ref.current!)
  expect(action).toHaveBeenCalledOnce()
  expect(screen.getByRole('dialog', { name: 'Style panel' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Styles' }))
  expect(change).toHaveBeenCalledWith(false)
})

it.each(['disabled', 'busy'] as const)('disables both segments when %s', (state) => {
  render(
    <SplitButton {...{ [state]: true }}>
      <SplitButtonGroup>
        <SplitButtonPrimary>Send</SplitButtonPrimary>
        <SplitButtonTrigger aria-label="Options">v</SplitButtonTrigger>
      </SplitButtonGroup>
      <SplitButtonContent>Options</SplitButtonContent>
    </SplitButton>
  )
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Options' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('menu')).toBeNull()
})

it('omits the trigger and panel for a single action', () => {
  render(
    <SplitButton hideMenu defaultOpen>
      <SplitButtonGroup>
        <SplitButtonPrimary>Allow</SplitButtonPrimary>
        <SplitButtonTrigger aria-label="Scope">v</SplitButtonTrigger>
      </SplitButtonGroup>
      <SplitButtonContent>Scope</SplitButtonContent>
    </SplitButton>
  )
  expect(screen.queryByRole('button', { name: 'Scope' })).toBeNull()
  expect(screen.queryByRole('menu')).toBeNull()
})

it('keeps the split state when a tooltip injects its own data-state', () => {
  render(
    <SplitButton open>
      <SplitButtonGroup>
        <SplitButtonPrimary>Send</SplitButtonPrimary>
        <SplitButtonTrigger aria-label="Options" data-state="closed">
          v
        </SplitButtonTrigger>
      </SplitButtonGroup>
    </SplitButton>
  )
  expect(screen.getByRole('button', { name: 'Options' }).getAttribute('data-state')).toBe('open')
})
