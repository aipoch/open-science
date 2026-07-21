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
        sessions: [{ projectName: 'cmrqcvg5i0000vo387wdhdudj', sessionId: 's1', kind: 'agent' }]
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
        sessions: [{ projectName: 'p1', sessionId: 's1', kind: 'agent' }]
      })
    })
    const row = await findButtonByName(/My Analysis — Fix data loader/)
    act(() => row.click())
    expect(openSession).toHaveBeenCalledWith('p1', 's1')
    expect(sendResponse).toHaveBeenCalledWith({ requestId: 'r4', choice: 'cancel' })
  })

  it('replies quit / minimize from the close-to-tray buttons', async () => {
    render()
    act(() => {
      emit({ requestId: 'r2', variant: 'close-to-tray', sessions: [] })
    })
    const minimizeButton = await findButtonByName(/minimize to tray/i)
    act(() => minimizeButton.click())
    expect(sendResponse).toHaveBeenCalledWith({ requestId: 'r2', choice: 'minimize' })
  })

  it('replies quit / cancel from the quit variant buttons', async () => {
    render()
    act(() => {
      emit({
        requestId: 'r3',
        variant: 'quit',
        sessions: [{ projectName: 'p', sessionId: 'x', kind: 'notebook' }]
      })
    })
    const quitButton = await findButtonByName(/^quit$/i)
    act(() => quitButton.click())
    expect(sendResponse).toHaveBeenCalledWith({ requestId: 'r3', choice: 'quit' })
  })

  it('renders null and does not throw when the desktop bridge is absent (web build)', () => {
    // Test double: web build omits the close-confirm channels entirely.
    window.api = { window: {} } as unknown as typeof window.api
    expect(() => render()).not.toThrow()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })
})
