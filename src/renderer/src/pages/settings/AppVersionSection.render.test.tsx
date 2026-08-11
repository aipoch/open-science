// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useThemeStore } from '@/stores/theme-store'
import { useUpdateStore } from '@/stores/update-store'
import { AppVersionSection } from './AppVersionSection'

vi.mock('@/assets/logo.png', () => ({ default: 'logo.png' }))
vi.mock('@/assets/logo-dark.png', () => ({ default: 'logo-dark.png' }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useThemeStore.getState().setPreference('light')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  useUpdateStore.setState({
    appInfo: {
      name: 'Open Science',
      version: '0.2.0',
      copyright: '© 2026 AIPOCH. All rights reserved.'
    },
    status: { state: 'up-to-date', current: '0.2.0', latest: '0.2.0' }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('AppVersionSection', () => {
  it('shows the app name, version, and copyright', () => {
    act(() => {
      root.render(<AppVersionSection />)
    })

    expect(container.textContent).toContain('Open Science')
    expect(container.textContent).toContain('v0.2.0')
    expect(container.textContent).toContain('© 2026 AIPOCH')
  })

  it('switches the About logo with an explicit app Theme', () => {
    act(() => {
      root.render(<AppVersionSection />)
    })

    expect(container.querySelector('img')?.getAttribute('src')).toBe('logo.png')

    act(() => useThemeStore.getState().setPreference('dark'))

    expect(container.querySelector('img')?.getAttribute('src')).toBe('logo-dark.png')
  })

  it('switches the About logo when System follows an OS appearance change', () => {
    let systemListener: ((event: { matches: boolean }) => void) | undefined
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        media: '(prefers-color-scheme: dark)',
        addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => {
          systemListener = listener
        },
        removeEventListener: vi.fn()
      }))
    )

    act(() => {
      useThemeStore.getState().setPreference('system')
      root.render(<AppVersionSection />)
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('logo.png')

    act(() => systemListener?.({ matches: true }))

    expect(useThemeStore.getState().preference).toBe('system')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('logo-dark.png')
  })

  it('shows an update action when a new version is available', () => {
    useUpdateStore.setState({
      status: { state: 'available', current: '0.2.0', latest: '0.3.0', notes: 'n' }
    })

    act(() => {
      root.render(<AppVersionSection />)
    })

    const button = Array.from(container.querySelectorAll('button')).find((element) =>
      /update to 0\.3\.0/i.test(element.textContent ?? '')
    )

    expect(button).toBeDefined()
  })
})
