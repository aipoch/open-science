// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsSegmentedControl } from './SettingsSegmentedControl'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  vi.unstubAllGlobals()
})

describe('SettingsSegmentedControl', () => {
  it('exposes radio semantics and forwards selection', async () => {
    const onValueChange = vi.fn()
    await act(async () => {
      root.render(
        <SettingsSegmentedControl
          value="default"
          options={[
            { value: 'default', label: 'Default' },
            { value: 'high', label: 'High' }
          ]}
          onValueChange={onValueChange}
          ariaLabel="Reasoning effort"
        />
      )
    })

    const radios = container.querySelectorAll<HTMLElement>('[role="radio"]')
    expect(radios).toHaveLength(2)
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    act(() => radios[1].click())
    expect(onValueChange).toHaveBeenCalledWith('high')
  })

  it('exposes tab semantics and enables the indicator transition after interaction', async () => {
    const onValueChange = vi.fn()
    await act(async () => {
      root.render(
        <SettingsSegmentedControl
          value="installed"
          options={[
            { value: 'installed', label: 'Installed' },
            { value: 'marketplace', label: 'Marketplace' }
          ]}
          onValueChange={onValueChange}
          ariaLabel="Specialist library"
          semantics="tab"
          columnWidth="7rem"
        />
      )
    })

    const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector<HTMLElement>('[aria-hidden="true"]')?.style.width).toBe('7rem')

    act(() => fireEvent.mouseDown(tabs[1], { button: 0 }))

    expect(onValueChange).toHaveBeenCalledWith('marketplace')
    expect(container.querySelector<HTMLElement>('[aria-hidden="true"]')?.className).toContain(
      'transition-transform'
    )
  })

  it('compacts only labels that do not fit at the normal font size', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe(): void {
          /* measurements are triggered explicitly by this test */
        }
        disconnect(): void {
          /* no retained observer resources in this test double */
        }
      }
    )

    await act(async () => {
      root.render(
        <SettingsSegmentedControl
          value="default"
          options={[
            { value: 'default', label: 'По умолчанию' },
            { value: 'high', label: 'High' }
          ]}
          onValueChange={vi.fn()}
          ariaLabel="Reasoning effort"
        />
      )
    })

    const labels = container.querySelectorAll<HTMLElement>('[data-slot="settings-segment-label"]')
    const texts = container.querySelectorAll<HTMLElement>(
      '[data-slot="settings-segment-label-text"]'
    )
    expect(labels).toHaveLength(2)
    expect(texts).toHaveLength(2)

    let longLabelWidth = 82
    Object.defineProperty(labels[0], 'clientWidth', { configurable: true, value: 56 })
    Object.defineProperty(labels[1], 'clientWidth', { configurable: true, value: 56 })
    Object.defineProperty(texts[0], 'scrollWidth', {
      configurable: true,
      get: () => longLabelWidth
    })
    Object.defineProperty(texts[1], 'scrollWidth', { configurable: true, value: 24 })
    Object.defineProperty(texts[0], 'scrollHeight', {
      configurable: true,
      get: () => (texts[0].style.fontSize === '10px' ? 36 : 22)
    })

    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver))
    })

    expect(labels[0].dataset.compact).toBe('true')
    expect(labels[0].dataset.compactSize).toBe('9')
    expect(texts[0].style.fontSize).toBe('9px')
    expect(labels[1].dataset.compact).toBeUndefined()
    expect(
      labels[1].querySelector('[data-slot="settings-segment-label-text"]')?.className
    ).toContain('text-xs')

    longLabelWidth = 46
    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver))
    })

    expect(labels[0].dataset.compact).toBeUndefined()
    expect(labels[0].dataset.compactSize).toBeUndefined()
    expect(texts[0].style.fontSize).toBe('')
    expect(
      labels[0].querySelector('[data-slot="settings-segment-label-text"]')?.className
    ).toContain('text-xs')
  })
})
