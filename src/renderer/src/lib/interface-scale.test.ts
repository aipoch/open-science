// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyInterfaceScale,
  getStoredInterfaceScale,
  INTERFACE_SCALE_STORAGE_KEY,
  isDesktopRenderer,
  persistInterfaceScale,
  resolveInterfaceScale
} from './interface-scale'

describe('interface scale preference', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { window: { setZoomFactor: vi.fn() } }
    })
  })

  it('defaults to 100% and rejects values outside the allow-list', () => {
    expect(resolveInterfaceScale()).toBe(1)

    localStorage.setItem(INTERFACE_SCALE_STORAGE_KEY, '1.2')
    expect(getStoredInterfaceScale()).toBeUndefined()
    expect(resolveInterfaceScale()).toBe(1)
  })

  it('reads, applies, and persists an allowed scale', async () => {
    localStorage.setItem(INTERFACE_SCALE_STORAGE_KEY, '1.25')
    expect(resolveInterfaceScale()).toBe(1.25)

    const setZoomFactor = vi.fn(async () => undefined)
    window.api.window.setZoomFactor = setZoomFactor
    await applyInterfaceScale(1.25)
    expect(setZoomFactor).toHaveBeenCalledWith(1.25)

    persistInterfaceScale(1.25)
    expect(localStorage.getItem(INTERFACE_SCALE_STORAGE_KEY)).toBe('1.25')
  })

  it('does not apply the desktop preference to the Web surface', async () => {
    document.documentElement.setAttribute('data-open-science-web-events', 'true')
    expect(isDesktopRenderer()).toBe(false)

    await applyInterfaceScale(1.25)
    expect(window.api.window.setZoomFactor).not.toHaveBeenCalled()
  })
})
