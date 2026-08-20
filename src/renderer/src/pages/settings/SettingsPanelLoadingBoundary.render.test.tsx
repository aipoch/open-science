// @vitest-environment jsdom
import { act, lazy } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsPanelLoadingBoundary } from './SettingsPanelLoadingBoundary'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SettingsPanelLoadingBoundary', () => {
  it('shows one centered, reduced-motion-safe loading state until a chunk resolves', async () => {
    let finish!: (module: { default: () => React.JSX.Element }) => void
    const Panel = lazy(
      () => new Promise<{ default: () => React.JSX.Element }>((resolve) => (finish = resolve))
    )

    await act(async () => {
      root.render(
        <SettingsPanelLoadingBoundary panelKey="skills" onClose={vi.fn()}>
          <Panel />
        </SettingsPanelLoadingBoundary>
      )
    })

    const loading = container.querySelector('[role="status"]')
    expect(loading?.textContent).toContain('Loading')
    expect(loading?.className).toContain('items-center')
    expect(loading?.className).toContain('justify-center')
    expect(loading?.querySelector('svg')?.getAttribute('class')).toContain(
      'motion-reduce:animate-none'
    )

    await act(async () => {
      finish({ default: () => <div>Loaded panel</div> })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Loaded panel')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('contains a rejected chunk and offers close and reload recovery', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onClose = vi.fn()
    const onReload = vi.fn()
    const Panel = lazy(() => Promise.reject(new Error('chunk unavailable')))

    await act(async () => {
      root.render(
        <SettingsPanelLoadingBoundary panelKey="skills" onClose={onClose} onReload={onReload}>
          <Panel />
        </SettingsPanelLoadingBoundary>
      )
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Settings panel couldn't be loaded."
    )
    const buttons = Array.from(container.querySelectorAll('button'))
    act(() => buttons.find((button) => button.textContent?.includes('Close'))?.click())
    act(() => buttons.find((button) => button.textContent?.includes('Reload'))?.click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(onReload).toHaveBeenCalledOnce()
    errorSpy.mockRestore()
  })
})
