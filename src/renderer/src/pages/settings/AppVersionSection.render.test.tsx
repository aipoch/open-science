// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'
import { AppVersionSection } from './AppVersionSection'

vi.mock('@/assets/logo.png', () => ({ default: 'logo.png' }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
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
