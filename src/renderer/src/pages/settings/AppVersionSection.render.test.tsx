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

  it('links help and release history to the canonical external resources', () => {
    act(() => {
      root.render(<AppVersionSection />)
    })

    const links = Array.from(container.querySelectorAll('a'))
    expect(links).toHaveLength(2)
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://www.aipoch.com/docs/',
      'https://github.com/aipoch/open-science/releases'
    ])
    expect(links.every((link) => link.target === '_blank' && link.rel === 'noreferrer')).toBe(true)
  })

  it('reveals resource details and primary-colored icons on pointer hover or keyboard focus', () => {
    act(() => {
      root.render(<AppVersionSection />)
    })

    const links = Array.from(container.querySelectorAll('a'))
    const icons = Array.from(container.querySelectorAll('[data-slot="about-resource-icon"]'))
    const titles = Array.from(container.querySelectorAll('[data-slot="about-resource-title"]'))
    const descriptions = Array.from(
      container.querySelectorAll('[data-slot="about-resource-description"]')
    )

    expect(links).toHaveLength(2)
    expect(links.every((link) => link.classList.contains('group'))).toBe(true)
    expect(icons).toHaveLength(2)
    expect(
      icons.every(
        (icon) =>
          icon.classList.contains('group-hover:text-primary') &&
          icon.classList.contains('group-focus-visible:text-primary')
      )
    ).toBe(true)
    expect(titles).toHaveLength(2)
    expect(titles.every((title) => !title.classList.contains('translate-y-2.5'))).toBe(true)
    expect(
      titles.every(
        (title) =>
          title.classList.contains('[@media(hover:hover)_and_(pointer:fine)]:translate-y-2.5') &&
          title.classList.contains(
            '[@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-y-0'
          ) &&
          title.classList.contains(
            '[@media(hover:hover)_and_(pointer:fine)]:group-focus-visible:translate-y-0'
          )
      )
    ).toBe(true)
    expect(descriptions).toHaveLength(2)
    expect(descriptions.every((description) => !description.classList.contains('opacity-0'))).toBe(
      true
    )
    expect(
      descriptions.every(
        (description) =>
          description.classList.contains('[@media(hover:hover)_and_(pointer:fine)]:opacity-0') &&
          description.classList.contains(
            '[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100'
          ) &&
          description.classList.contains(
            '[@media(hover:hover)_and_(pointer:fine)]:group-focus-visible:opacity-100'
          )
      )
    ).toBe(true)
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

  it.each([
    ['restart', 'Restart to update'],
    ['installer', 'Update downloaded — open the installer to finish']
  ] as const)('shows the ready instruction for the %s apply strategy', (applyKind, message) => {
    useUpdateStore.setState({
      status: { state: 'ready', current: '0.2.0', latest: '0.3.0', applyKind }
    })

    act(() => {
      root.render(<AppVersionSection />)
    })

    expect(container.textContent).toContain(message)
  })

  it.each([
    ['downloading', true],
    ['ready', false]
  ] as const)('sets check availability while the update is %s', (state, disabled) => {
    useUpdateStore.setState({
      status: { state, current: '0.2.0', latest: '0.3.0' }
    })

    act(() => {
      root.render(<AppVersionSection />)
    })

    const checkButton = Array.from(container.querySelectorAll('button')).find((element) =>
      /check now/i.test(element.textContent ?? '')
    )
    expect(checkButton?.disabled).toBe(disabled)
  })
})
