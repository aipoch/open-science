// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ComposerMessageQueueContent, ComposerMessageQueueTrigger } from './ComposerMessageQueue'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

afterEach(() => {
  act(() => root?.unmount())
  Reflect.deleteProperty(document, 'elementFromPoint')
})

const click = (element: Element): void => {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

const dispatchPointer = (
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientY: number,
  pointerType: 'mouse' | 'touch'
): void => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY })
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
    pointerType: { value: pointerType }
  })
  act(() => element.dispatchEvent(event))
}

const QueueHarness = (
  props: Omit<React.ComponentProps<typeof ComposerMessageQueueContent>, 'expanded'>
): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div data-testid="notebook-bar">
        <ComposerMessageQueueTrigger
          items={props.items}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />
      </div>
      <div data-testid="composer">
        <ComposerMessageQueueContent {...props} expanded={expanded} />
      </div>
    </>
  )
}

describe('ComposerMessageQueue', () => {
  it('expands on demand and exposes the queued message actions', () => {
    container = document.createElement('div')
    root = createRoot(container)
    const actions = {
      move: vi.fn(),
      moveTo: vi.fn(),
      remove: vi.fn(),
      edit: vi.fn(),
      sendNow: vi.fn(async () => undefined)
    }
    act(() =>
      root.render(
        <QueueHarness
          items={[
            {
              id: 'queued-a',
              text: 'Analyze the next sample with a deliberately long single-line prompt',
              attachmentCount: 1,
              phase: 'queued'
            }
          ]}
          announcement="Message added to queue."
          actions={actions}
        />
      )
    )

    const trigger = container.querySelector('[data-testid="composer-queue-trigger"]')!
    expect(trigger.parentElement?.dataset.testid).toBe('notebook-bar')
    expect(trigger.textContent).toContain('Not saved')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="composer-queue-item"]')).toBeNull()
    click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(
      container.querySelector('[data-testid="composer"] [data-testid="composer-queue-item"]')
    ).not.toBeNull()
    const preview = container.querySelector('p[title]')!
    expect(preview.textContent).toContain('Analyze the next sample')
    expect(preview.className).toContain('truncate')
    expect(preview.parentElement?.className).toContain('overflow-hidden')
    expect(container.textContent).toContain('Attachments: 1')

    click(container.querySelector('[title="Edit queued message"]')!)
    click(container.querySelector('[title="Remove queued message"]')!)
    click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Send now')
      )!
    )
    expect(actions.edit).toHaveBeenCalledWith('queued-a')
    expect(actions.remove).toHaveBeenCalledWith('queued-a')
    expect(actions.sendNow).toHaveBeenCalledWith('queued-a')
  })

  it('shows a wait-until-idle hint on a deferred queued row', () => {
    container = document.createElement('div')
    root = createRoot(container)
    act(() =>
      root.render(
        <QueueHarness
          items={[
            {
              id: 'queued-a',
              text: 'Follow up after this run',
              attachmentCount: 0,
              phase: 'queued',
              deferredUntilIdle: true
            }
          ]}
          announcement="Queued message will send after the current run finishes."
          actions={{
            move: vi.fn(),
            moveTo: vi.fn(),
            remove: vi.fn(),
            edit: vi.fn(),
            sendNow: vi.fn(async () => undefined)
          }}
        />
      )
    )
    click(container.querySelector('[data-testid="composer-queue-trigger"]')!)
    const row = container.querySelector('[data-testid="composer-queue-item"]')!
    expect(row.textContent).toContain('Queued message will send after the current run finishes.')
    expect(row.querySelector('[role="alert"]')).toBeNull()
    expect(
      Array.from(row.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Send now')
      )
    ).toBe(true)
  })

  it('maps arrow keys on the drag handle to keyboard reordering', () => {
    container = document.createElement('div')
    root = createRoot(container)
    const move = vi.fn()
    act(() =>
      root.render(
        <QueueHarness
          items={[
            {
              id: 'queued-a',
              text: 'First',
              attachmentCount: 0,
              phase: 'queued'
            },
            {
              id: 'queued-b',
              text: 'Second',
              attachmentCount: 0,
              phase: 'queued'
            }
          ]}
          announcement=""
          actions={{
            move,
            moveTo: vi.fn(),
            remove: vi.fn(),
            edit: vi.fn(),
            sendNow: vi.fn(async () => undefined)
          }}
        />
      )
    )
    click(container.querySelector('[data-testid="composer-queue-trigger"]')!)
    const handle = container.querySelector('[aria-label="Reorder queued message 1"]')!
    act(() =>
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )
    expect(move).toHaveBeenCalledWith('queued-a', 'down')
  })

  it('reorders with mouse and touch pointers after the movement threshold', () => {
    container = document.createElement('div')
    root = createRoot(container)
    const moveTo = vi.fn()
    act(() =>
      root.render(
        <QueueHarness
          items={[
            { id: 'queued-a', text: 'First', attachmentCount: 0, phase: 'queued' },
            { id: 'queued-b', text: 'Second', attachmentCount: 0, phase: 'queued' }
          ]}
          announcement=""
          actions={{
            move: vi.fn(),
            moveTo,
            remove: vi.fn(),
            edit: vi.fn(),
            sendNow: vi.fn(async () => undefined)
          }}
        />
      )
    )
    click(container.querySelector('[data-testid="composer-queue-trigger"]')!)
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="composer-queue-item"]')
    )
    vi.spyOn(rows[0], 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 30,
      left: 0,
      right: 300,
      width: 300,
      height: 30,
      x: 0,
      y: 0,
      toJSON: () => undefined
    })
    vi.spyOn(rows[1], 'getBoundingClientRect').mockReturnValue({
      top: 30,
      bottom: 60,
      left: 0,
      right: 300,
      width: 300,
      height: 30,
      x: 0,
      y: 30,
      toJSON: () => undefined
    })
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => rows[1])
    })
    const handle = rows[0].querySelector('button') as HTMLButtonElement
    handle.setPointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)
    handle.releasePointerCapture = vi.fn()

    dispatchPointer(handle, 'pointerdown', 10, 'mouse')
    dispatchPointer(handle, 'pointermove', 50, 'mouse')
    expect(rows[0].className).toContain('opacity-25')
    expect(rows[1].style.transform).toBe('translateY(-30px)')
    dispatchPointer(handle, 'pointerup', 50, 'mouse')
    expect(moveTo).toHaveBeenCalledWith('queued-a', 'queued-b', 'after')
    expect(rows[1].style.transform).toBe('translateY(0px)')

    moveTo.mockClear()
    dispatchPointer(handle, 'pointerdown', 10, 'touch')
    dispatchPointer(handle, 'pointermove', 14, 'touch')
    expect(rows[0].className).not.toContain('opacity-25')
    expect(moveTo).not.toHaveBeenCalled()

    dispatchPointer(handle, 'pointermove', 50, 'touch')
    expect(rows[0].className).toContain('opacity-25')
    expect(rows[1].style.transform).toBe('translateY(-30px)')

    dispatchPointer(handle, 'pointerup', 50, 'touch')
    expect(moveTo).toHaveBeenCalledWith('queued-a', 'queued-b', 'after')
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(rows[1].style.transform).toBe('translateY(0px)')
  })
})
