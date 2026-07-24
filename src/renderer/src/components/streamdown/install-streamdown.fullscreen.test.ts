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
