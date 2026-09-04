// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CloseConfirmModal } from './CloseConfirmModal'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import type { CloseConfirmRequest } from '../../../shared/window-controls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let requestListener: ((payload: CloseConfirmRequest) => void) | undefined
const sendResponse = vi.fn()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  sendResponse.mockClear()
  requestListener = undefined
  // Test double: only window.api.window is exercised by this component.
  window.api = {
    window: {
      onCloseConfirmRequest: (cb: (payload: CloseConfirmRequest) => void) => {
        requestListener = cb
        return () => (requestListener = undefined)
      },
      sendCloseConfirmResponse: sendResponse
    }
  } as unknown as typeof window.api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const emit = (payload: CloseConfirmRequest): void => requestListener?.(payload)

const render = (): void => {
  act(() => root.render(<CloseConfirmModal />))
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

const findByText = async (pattern: RegExp): Promise<Element> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const match = Array.from(document.body.querySelectorAll('*')).find((el) =>
      pattern.test(el.textContent ?? '')
    )
    if (match) return match
    await flush()
  }
  throw new Error(`expected to find text matching ${pattern}`)
}

const findButtonByName = async (pattern: RegExp): Promise<HTMLButtonElement> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const match = Array.from(document.querySelectorAll('button')).find((button) =>
      pattern.test(button.textContent ?? '')
    )
    if (match) return match
    await flush()
  }
  throw new Error(`expected to find a button matching ${pattern}`)
}

describe('CloseConfirmModal', () => {
  it('retains a covered close request until its presentation becomes active', async () => {
    act(() => root.render(<CloseConfirmModal active={false} />))
    act(() => {
      emit({ requestId: 'r-covered', variant: 'close-to-tray', sessions: [] })
    })

    expect(sendResponse).toHaveBeenCalledWith({ requestId: 'r-covered', ack: true })
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(sendResponse).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'r-covered', choice: expect.anything() })
    )

    act(() => root.render(<CloseConfirmModal active />))

    await findByText(/Minimize or quit?/)
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
  })

  it('uses shared settings dialog chrome for the close confirmation', async () => {
    render()
    act(() => {
      emit({ requestId: 'r-style', variant: 'close-to-tray', sessions: [] })
    })

    await findByText(/Minimize or quit?/)

    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')

    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(overlay?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(dialog?.className).toContain('overflow-hidden')
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-b border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-t border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
  })

  it('reports whether the modal is obscuring the active conversation', async () => {
    const onOpenChange = vi.fn()
    act(() => root.render(<CloseConfirmModal onOpenChange={onOpenChange} />))
    act(() => {
      emit({ requestId: 'r-visibility', variant: 'close-to-tray', sessions: [] })
    })

    expect(onOpenChange).toHaveBeenCalledWith(true)

    const minimize = await findButtonByName(/Minimize to tray/)
    act(() => minimize.click())
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('acks and shows the resolved project NAME (not the id main sent) plus the title', async () => {
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'My Analysis' } as never],
      isLoaded: true,
      loadError: undefined
    })
    useSessionStore.setState({
      sessions: [{ id: 's1', projectId: 'p1', title: 'Fix data loader' } as never],
      selectedSessionId: undefined
    })
    render()
    act(() => {
      emit({
        requestId: 'r1',
        variant: 'close-to-tray',
        // main sends a project *id* here; the modal must resolve the human name instead.
        sessions: [{ projectId: 'cmrqcvg5i0000vo387wdhdudj', sessionId: 's1', kind: 'agent' }]
      })
    })
    expect(sendResponse).toHaveBeenCalledWith({ requestId: 'r1', ack: true })
    await findByText(/My Analysis — Fix data loader/)
    expect(document.body.textContent).not.toContain('cmrqcvg5i0000vo387wdhdudj')
  })

  it('opens the session and cancels the close when a running-session row is clicked', async () => {
    const openSession = vi.fn()
    useNavigationStore.setState({ openSession } as never)
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'My Analysis' } as never],
      isLoaded: true,
      loadError: undefined
    })
    useSessionStore.setState({
      sessions: [{ id: 's1', projectId: 'p1', title: 'Fix data loader' } as never],
      selectedSessionId: undefined
    })
    render()
    act(() => {
      emit({
        requestId: 'r4',
        variant: 'quit',
        sessions: [{ projectId: 'p1', sessionId: 's1', kind: 'agent' }]
      })
    })
    const row = await findButtonByName(/My Analysis — Fix data loader/)
    act(() => row.click())
    expect(openSession).toHaveBeenCalledWith('p1', 's1', 'user', expect.any(Function))
    expect(sendResponse).not.toHaveBeenCalledWith({ requestId: 'r4', choice: 'cancel' })
    act(() => openSession.mock.calls[0]?.[3]?.())
    expect(sendResponse).toHaveBeenCalledWith({ requestId: 'r4', choice: 'cancel' })
  })

  it('defaults to remembering the close-to-tray choice', async () => {
    render()
    act(() => {
      emit({ requestId: 'r2', variant: 'close-to-tray', sessions: [] })
    })
    const remember = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(remember?.checked).toBe(true)

    const minimizeButton = await findButtonByName(/minimize to tray/i)
    act(() => minimizeButton.click())
    expect(sendResponse).toHaveBeenCalledWith({
      requestId: 'r2',
      choice: 'minimize',
      remember: true
    })
  })

  it('does not remember the choice after the checkbox is cleared', async () => {
    render()
    act(() => {
      emit({ requestId: 'r5', variant: 'close-to-tray', sessions: [] })
    })
    const remember = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')
    act(() => remember?.click())

    const quitButton = await findButtonByName(/^quit$/i)
    act(() => quitButton.click())
    expect(sendResponse).toHaveBeenCalledWith({
      requestId: 'r5',
      choice: 'quit',
      remember: false
    })
  })

  it('replies quit / cancel from the quit variant buttons', async () => {
    render()
    act(() => {
      emit({
        requestId: 'r3',
        variant: 'quit',
        sessions: [{ projectId: 'p', sessionId: 'x', kind: 'notebook' }]
      })
    })
    const quitButton = await findButtonByName(/^quit$/i)
    act(() => quitButton.click())
    expect(sendResponse).toHaveBeenCalledWith({ requestId: 'r3', choice: 'quit' })
  })

  it('explains an unfinished save and lets the user retry the orderly quit', async () => {
    render()
    act(() => {
      emit({ requestId: 'r-persistence', variant: 'persistence-failed', sessions: [] })
    })

    await findByText(/Saving is not finished/)
    expect(document.body.textContent).toContain(
      'Open Science could not confirm that all recent changes were saved. Retry saving, or force quit and risk losing recent changes.'
    )
    expect(
      Array.from(document.querySelectorAll('button'), (button) => button.textContent)
    ).not.toContain('Quit')
    const retryButton = await findButtonByName(/^Retry saving$/)
    act(() => retryButton.click())
    expect(sendResponse).toHaveBeenCalledWith({
      requestId: 'r-persistence',
      choice: 'retry'
    })
  })

  it('requires an explicit destructive action to force quit after an unfinished save', async () => {
    render()
    act(() => {
      emit({ requestId: 'r-force-persistence', variant: 'persistence-failed', sessions: [] })
    })

    const forceQuitButton = await findButtonByName(/^Force quit$/)
    expect(forceQuitButton.className).toContain('bg-destructive')
    act(() => forceQuitButton.click())
    expect(sendResponse).toHaveBeenCalledWith({
      requestId: 'r-force-persistence',
      choice: 'force-quit'
    })
  })

  it('blocks quitting for delegated work and only acknowledges by staying in the app', async () => {
    render()
    act(() => {
      emit({
        requestId: 'r-delegated',
        variant: 'quit',
        sessions: [{ projectId: 'p', sessionId: 'child-running', kind: 'delegated' }]
      })
    })

    await findByText(/Subagents are still running/)
    expect(document.body.textContent).toMatch(/stop their subagents before quitting/i)
    expect(document.body.textContent).not.toMatch(/\bQuit\b/)
    const returnButton = await findButtonByName(/Return to tasks/)
    act(() => returnButton.click())
    expect(sendResponse).toHaveBeenCalledWith({ requestId: 'r-delegated', choice: 'cancel' })
  })

  it('renders null and does not throw when the desktop bridge is absent (web build)', () => {
    // Test double: web build omits the close-confirm channels entirely.
    window.api = { window: {} } as unknown as typeof window.api
    expect(() => render()).not.toThrow()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })
})
