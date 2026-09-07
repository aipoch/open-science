// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceAssistantTurnCompletion } from './WorkspaceMessageItem'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renderGroup = (): ReturnType<typeof render> =>
  render(
    <TooltipProvider delayDuration={200} skipDelayDuration={300}>
      {['first', 'second'].map((id) => (
        <WorkspaceAssistantTurnCompletion
          key={id}
          message={{
            id,
            role: 'agent',
            content: 'Done',
            status: 'complete',
            eventIds: [],
            createdAt: 1710000000000,
            updatedAt: 1710000001000,
            completedAt: 1710000001000,
            turnUsage: { inputTokens: 12, cacheTokens: 3, outputTokens: 4 }
          }}
          canBranchInNewSession
          onBranchInNewSession={() => {}}
        />
      ))}
    </TooltipProvider>
  )
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const hover = (element: Element): void => {
  fireEvent.pointerOver(element, { pointerType: 'mouse' })
  fireEvent.pointerMove(element, { pointerType: 'mouse' })
}
const leave = (element: Element): void => {
  fireEvent.pointerLeave(element)
  fireEvent.pointerMove(document.body, { pointerType: 'mouse', clientX: 1000, clientY: 1000 })
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('shares the skip window across messages and restores the initial delay after leaving', async () => {
  vi.useFakeTimers()
  const view = renderGroup()
  const [first, second] = view.getAllByRole('button', { name: 'Copy message' })
  hover(first)
  await advance(199)
  expect(first.getAttribute('data-state')).toBe('closed')
  await advance(1)
  expect(first.getAttribute('data-state')).toBe('delayed-open')
  leave(first)
  hover(second)
  await advance(0)
  expect(second.getAttribute('data-state')).toBe('instant-open')
  leave(second)
  await advance(301)
  hover(first)
  await advance(199)
  expect(first.getAttribute('data-state')).toBe('closed')
  await advance(1)
  expect(first.getAttribute('data-state')).toBe('delayed-open')
})

it('delays Calls initially and shares its warm window with the timestamp and actions', async () => {
  vi.useFakeTimers()
  const view = renderGroup()
  const calls = view.getAllByRole('button', { name: 'Token usage for this response' })[0]
  hover(calls)
  await advance(199)
  expect(document.querySelector('[data-slot="turn-token-usage-popover"]')).toBeNull()
  await advance(1)
  expect(document.querySelector('[data-slot="turn-token-usage-popover"]')).not.toBeNull()
  leave(calls)
  const timestamp = view.container.querySelector('time')!
  expect(timestamp.hasAttribute('title')).toBe(false)
  hover(timestamp)
  await advance(0)
  expect(timestamp.getAttribute('data-state')).toBe('instant-open')
  leave(timestamp)
  const copy = view.getAllByRole('button', { name: 'Copy message' })[1]
  hover(copy)
  await advance(0)
  expect(copy.getAttribute('data-state')).toBe('instant-open')
})

it('opens Calls on click or keyboard focus and dismisses it with Escape', async () => {
  const view = renderGroup()
  const calls = view.getAllByRole('button', { name: 'Token usage for this response' })[0]
  fireEvent.click(calls)
  expect(document.querySelector('[data-slot="turn-token-usage-popover"]')).not.toBeNull()
  fireEvent.keyDown(calls, { key: 'Escape' })
  expect(document.querySelector('[data-slot="turn-token-usage-popover"]')).toBeNull()
  fireEvent.focus(calls)
  expect(document.querySelector('[data-slot="turn-token-usage-popover"]')).not.toBeNull()
})
