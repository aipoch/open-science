// @vitest-environment jsdom
import { act, lazy } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsPanelLoadingBoundary } from './SettingsPanelLoadingBoundary'
import { lazyWithRetry } from './settings-panel-loader'

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

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label
  )

const surfaceButtons = (): HTMLButtonElement[] => {
  const section = container.querySelector('[role="alert"]')?.closest('section')
  return Array.from(section?.querySelectorAll('button') ?? [])
}

describe('SettingsPanelLoadingBoundary', () => {
  it('preserves healthy children and recovers a failed route when resetKey changes', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const Panel = ({ fail }: { fail: boolean }): React.JSX.Element => {
      if (fail) throw new Error('model route unavailable')
      return <input aria-label="Model draft" defaultValue="draft" />
    }
    const renderRoute = async (resetKey: string, fail = false): Promise<void> => {
      await act(async () => {
        root.render(
          <SettingsPanelLoadingBoundary panelKey="model:tabs" resetKey={resetKey}>
            <Panel fail={fail} />
          </SettingsPanelLoadingBoundary>
        )
      })
    }

    try {
      await renderRoute('list')
      const input = container.querySelector('input')!
      input.value = 'retained draft'
      await renderRoute('local-models')
      expect(container.querySelector('input')).toBe(input)
      expect(input.value).toBe('retained draft')

      await renderRoute('list', true)
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      await renderRoute('list')
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      await renderRoute('local-models', true)
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      await renderRoute('list')
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.querySelector('input')).not.toBeNull()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('announces loading immediately and shows skeleton placeholders only after a delay', async () => {
    let finish!: (module: { default: () => React.JSX.Element }) => void
    const Panel = lazy(
      () => new Promise<{ default: () => React.JSX.Element }>((resolve) => (finish = resolve))
    )

    await act(async () => {
      root.render(
        <SettingsPanelLoadingBoundary panelKey="skills">
          <Panel />
        </SettingsPanelLoadingBoundary>
      )
    })

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain('Loading…')
    // Skeleton bars stay hidden below the delay threshold so fast loads never flash them.
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(container.querySelector('[role="status"]')).not.toBeNull()

    await act(async () => {
      finish({ default: () => <div>Loaded panel</div> })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Loaded panel')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('retries a failed panel in place from a compact single-action notice', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let shouldFail = true
    const Panel = (): React.JSX.Element => {
      if (shouldFail) throw new Error('chunk unavailable')
      return <div>Loaded panel</div>
    }

    try {
      await act(async () => {
        root.render(
          <SettingsPanelLoadingBoundary panelKey="skills">
            <Panel />
          </SettingsPanelLoadingBoundary>
        )
      })

      const alert = container.querySelector('[role="alert"]')
      expect(alert?.textContent).toContain("Settings panel couldn't be loaded.")
      expect(alert?.textContent).toContain('Retry to load it in place')
      // Compact surface: no full-page brand mark, no h1, compact outline action.
      expect(container.querySelector('svg[viewBox="0 0 432 432"]')).toBeNull()
      expect(alert?.querySelector('h1')).toBeNull()
      expect(surfaceButtons()).toHaveLength(1)
      expect(findButton('Retry')?.dataset.variant).toBe('outline')

      shouldFail = false
      await act(async () => findButton('Retry')?.click())
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.textContent).toContain('Loaded panel')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('re-invokes the panel import on each retry and escalates to a single Reload action', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onReload = vi.fn()
    const loader = vi
      .fn<() => Promise<{ default: () => React.JSX.Element }>>()
      .mockRejectedValue(new Error('chunk unavailable'))
    const Panel = lazyWithRetry(loader)

    try {
      await act(async () => {
        root.render(
          <SettingsPanelLoadingBoundary panelKey="skills" onReload={onReload}>
            <Panel />
          </SettingsPanelLoadingBoundary>
        )
        await Promise.resolve()
      })
      expect(loader).toHaveBeenCalledTimes(1)
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Settings panel couldn't be loaded."
      )
      expect(findButton('Reload')).toBeUndefined()

      // Each retry creates a fresh lazy instance, so the import really runs again.
      await act(async () => {
        findButton('Retry')?.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(loader).toHaveBeenCalledTimes(2)
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Settings panel couldn't be loaded."
      )
      expect(findButton('Reload')).toBeUndefined()

      await act(async () => {
        findButton('Retry')?.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(loader).toHaveBeenCalledTimes(3)
      const alert = container.querySelector('[role="alert"]')
      expect(alert?.textContent).toContain("Retrying didn't fix it")
      expect(alert?.textContent).toContain('Reload Open-Science to try loading this panel again.')
      // Escalated: Reload is the only action; no Retry, no Close.
      expect(surfaceButtons()).toHaveLength(1)
      expect(findButton('Reload')).toBeDefined()
      expect(findButton('Retry')).toBeUndefined()
      expect(findButton('Close')).toBeUndefined()

      act(() => findButton('Reload')?.click())
      expect(onReload).toHaveBeenCalledOnce()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
