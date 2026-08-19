// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsSegmentedControl } from './SettingsSegmentedControl'

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
})
