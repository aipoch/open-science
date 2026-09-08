// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { createElectronCloseConfirm } from '../../../main/window-close-confirm'
import {
  WINDOW_CLOSE_CONFIRM_DISMISS_CHANNEL,
  WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL,
  WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL
} from '../../../shared/window-controls'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CloseConfirmModal } from './CloseConfirmModal'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import type { CloseConfirmDismissal, CloseConfirmRequest } from '../../../shared/window-controls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const electronBoundary = vi.hoisted(() => ({
  ipc: undefined as EventEmitter | undefined,
  showMessageBox: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: { showMessageBox: electronBoundary.showMessageBox },
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      electronBoundary.ipc!.on(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
      electronBoundary.ipc!.removeListener(channel, listener)
  }
}))

let requestListener: ((payload: CloseConfirmRequest) => void) | undefined
let dismissListener: ((payload: CloseConfirmDismissal) => void) | undefined
const sendResponse = vi.fn()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  sendResponse.mockClear()
  requestListener = undefined
  dismissListener = undefined
  // Test double: only window.api.window is exercised by this component.
  window.api = {
    window: {
      onCloseConfirmRequest: (cb: (payload: CloseConfirmRequest) => void) => {
        requestListener = cb
        return () => (requestListener = undefined)
      },
      onCloseConfirmDismiss: (cb: (payload: CloseConfirmDismissal) => void) => {
        dismissListener = cb
        return () => (dismissListener = undefined)
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
  it('removes the web confirmation when the native fallback cancels quit', async () => {
    vi.useFakeTimers()
    const ipc = new EventEmitter()
    electronBoundary.ipc = ipc
    electronBoundary.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: (channel: string, payload: CloseConfirmRequest): void => {
        if (channel === WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL) emit(payload)
        if (channel === WINDOW_CLOSE_CONFIRM_DISMISS_CHANNEL) dismissListener?.(payload)
      }
    })
    const ownerWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      focus: vi.fn(),
      webContents: contents
    } as unknown as BrowserWindow
    sendResponse.mockImplementation((payload) =>
      ipc.emit(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL, { sender: contents }, payload)
    )
    const confirm = createElectronCloseConfirm(() => ownerWindow, {
      get: async () => undefined,
      set: async () => undefined
    })
    let pending: ReturnType<typeof confirm> | undefined
    try {
      render()
      act(() => {
        pending = confirm('quit', [], true)
      })
      expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ack: true }))
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
      await act(async () => {
        contents.emit('unresponsive')
        await vi.advanceTimersByTimeAsync(10_001)
        await pending
      })
      await expect(pending).resolves.toBe('cancel')
      expect(electronBoundary.showMessageBox).toHaveBeenCalledTimes(1)
      expect(ipc.listenerCount(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL)).toBe(0)
      expect
        .soft(
          document.querySelector('[role="alertdialog"]'),
          'native cancel must not leave actionable stale web controls'
        )
        .toBeNull()
      const staleQuit = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Quit'
      )
      if (staleQuit) {
        act(() => staleQuit.click())
        expect(sendResponse).toHaveBeenLastCalledWith(expect.objectContaining({ choice: 'quit' }))
        await expect(pending).resolves.toBe('cancel')
      }
    } finally {
      sendResponse.mockReset()
      vi.useRealTimers()
    }
  })

  it('withdraws only the matching request and reports visibility without replying', () => {
    const onOpenChange = vi.fn()
    act(() => root.render(<CloseConfirmModal onOpenChange={onOpenChange} />))
    act(() => emit({ requestId: 'old', variant: 'quit', sessions: [] }))
    act(() => emit({ requestId: 'new', variant: 'quit', sessions: [] }))
    act(() => dismissListener?.({ requestId: 'old' }))
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    act(() => dismissListener?.({ requestId: 'new' }))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(sendResponse.mock.calls.every(([response]) => response.ack === true)).toBe(true)
    act(() => root.render(<></>))
    expect(requestListener).toBeUndefined()
    expect(dismissListener).toBeUndefined()
  })

  it('keeps a long running-task list separate from the close actions', async () => {
    render()
    act(() =>
      emit({
        requestId: 'many-tasks',
        variant: 'quit',
        sessions: Array.from({ length: 35 }, (_, index) => ({
          sessionId: `scroll-session-${index}`,
          projectId: `scroll-project-${index}`,
          kind: 'agent'
        }))
      })
    )
    const dialog = document.querySelector('[role="alertdialog"]')!
    const viewport = dialog.querySelector('[data-slot="scroll-area-viewport"]')!
    expect(viewport.querySelectorAll('li')).toHaveLength(35)
    expect(viewport.textContent).toContain('scroll-session-34')
    const cancel = await findButtonByName(/^Cancel$/)
    expect(viewport.contains(cancel)).toBe(false)
    act(() => cancel.click())
    expect(sendResponse).toHaveBeenCalledWith({ requestId: 'many-tasks', choice: 'cancel' })
  })

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
      'Open-Science could not confirm that all recent changes were saved. Retry saving, or force quit and risk losing recent changes.'
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
