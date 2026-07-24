// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installStreamdown } from './install-streamdown'

const createMermaidFullscreen = (): {
  overlay: HTMLDivElement
  closeButton: HTMLButtonElement
  panelButton: HTMLButtonElement
} => {
  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center'
  overlay.setAttribute('role', 'button')

  const closeButton = document.createElement('button')
  const panel = document.createElement('div')
  panel.setAttribute('role', 'presentation')
  const panelButton = document.createElement('button')
  panel.appendChild(panelButton)
  overlay.append(closeButton, panel)
  document.body.appendChild(overlay)

  return { overlay, closeButton, panelButton }
}

const createTableFullscreen = (): {
  overlay: HTMLDivElement
  closeButton: HTMLButtonElement
} => {
  const overlay = document.createElement('div')
  overlay.dataset.streamdown = 'table-fullscreen'
  const panel = document.createElement('div')
  panel.setAttribute('role', 'presentation')
  const header = document.createElement('div')
  const closeButton = document.createElement('button')
  header.appendChild(closeButton)
  panel.appendChild(header)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  return { overlay, closeButton }
}

const createOpenLinkSafetyDialog = (): HTMLButtonElement => {
  const panel = document.createElement('div')
  panel.dataset.streamdown = 'link-safety-panel'
  panel.dataset.state = 'open'
  const button = document.createElement('button')
  panel.appendChild(button)
  document.body.appendChild(panel)
  return button
}

let uninstall: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  uninstall = installStreamdown()
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Mermaid fullscreen exit adapter', () => {
  it('delays the original close-button action until the exit animation completes', () => {
    const { overlay, closeButton } = createMermaidFullscreen()
    const originalClose = vi.fn()
    closeButton.addEventListener('click', originalClose)

    closeButton.click()

    expect(overlay.dataset.fullscreenState).toBe('closing')
    expect(originalClose).not.toHaveBeenCalled()

    vi.advanceTimersByTime(150)

    expect(originalClose).toHaveBeenCalledTimes(1)
  })

  it('does not intercept controls inside the fullscreen panel', () => {
    const { overlay, panelButton } = createMermaidFullscreen()
    const onPanelAction = vi.fn()
    panelButton.addEventListener('click', onPanelAction)

    panelButton.click()

    expect(onPanelAction).toHaveBeenCalledTimes(1)
    expect(overlay.dataset.fullscreenState).toBeUndefined()
  })

  it('keeps keyboard focus inside the dynamic fullscreen layer', async () => {
    const { closeButton, panelButton } = createMermaidFullscreen()

    await vi.runAllTimersAsync()
    panelButton.focus()
    panelButton.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    )

    expect(document.activeElement).toBe(closeButton)

    closeButton.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )

    expect(document.activeElement).toBe(panelButton)
  })

  it('skips hidden controls when cycling fullscreen focus', async () => {
    const { closeButton, panelButton } = createMermaidFullscreen()
    const hiddenButton = document.createElement('button')
    hiddenButton.style.display = 'none'
    panelButton.before(hiddenButton)

    await vi.runAllTimersAsync()
    closeButton.focus()
    closeButton.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    )

    expect(document.activeElement).toBe(panelButton)
  })

  it('leaves keyboard handling to an open link safety dialog above the fullscreen layer', async () => {
    const { overlay } = createMermaidFullscreen()
    const linkDialogButton = createOpenLinkSafetyDialog()

    await vi.runAllTimersAsync()
    linkDialogButton.focus()

    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true
    })
    linkDialogButton.dispatchEvent(tabEvent)
    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    })
    linkDialogButton.dispatchEvent(escapeEvent)

    expect(tabEvent.defaultPrevented).toBe(false)
    expect(escapeEvent.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(linkDialogButton)
    expect(overlay.dataset.fullscreenState).toBeUndefined()
  })

  it('blocks backdrop dismissal to match the shared fullscreen dialog', () => {
    const { overlay, closeButton } = createMermaidFullscreen()
    const originalClose = vi.fn()
    closeButton.addEventListener('click', originalClose)

    overlay.click()

    expect(originalClose).not.toHaveBeenCalled()
    expect(overlay.dataset.fullscreenState).toBeUndefined()
  })

  it('closes immediately when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const { overlay, closeButton } = createMermaidFullscreen()
    const originalClose = vi.fn()
    closeButton.addEventListener('click', originalClose)

    closeButton.click()

    expect(originalClose).toHaveBeenCalledTimes(1)
    expect(overlay.dataset.fullscreenState).toBeUndefined()
  })
})

describe('Table fullscreen exit adapter', () => {
  it('uses the shared contract and delays close until the exit animation completes', async () => {
    const { overlay, closeButton } = createTableFullscreen()
    const originalClose = vi.fn()
    closeButton.addEventListener('click', originalClose)

    await vi.runAllTimersAsync()
    closeButton.click()

    expect(overlay.dataset.fullscreenState).toBe('closing')
    expect(originalClose).not.toHaveBeenCalled()

    vi.advanceTimersByTime(150)

    expect(originalClose).toHaveBeenCalledOnce()
  })
})
