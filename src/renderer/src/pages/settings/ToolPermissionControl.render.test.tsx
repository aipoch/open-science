// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToolPermissionControl } from './ToolPermissionControl'

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
  document.body.innerHTML = ''
})

const radio = (label: string): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${label}"]`)

describe('ToolPermissionControl', () => {
  it('renders three radios and checks the one matching value', () => {
    act(() => {
      root.render(
        <ToolPermissionControl value="block" onChange={vi.fn()} label="Permission for list_marts" />
      )
    })

    expect(document.body.querySelectorAll('[role="radio"]')).toHaveLength(3)
    expect(radio('Always allow')?.getAttribute('aria-checked')).toBe('false')
    expect(radio('Ask each time')?.getAttribute('aria-checked')).toBe('false')
    expect(radio('Block')?.getAttribute('aria-checked')).toBe('true')
  })

  it('calls onChange("allow") when Always allow is clicked', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(
        <ToolPermissionControl
          value="block"
          onChange={onChange}
          label="Permission for list_marts"
        />
      )
    })

    act(() => radio('Always allow')?.click())
    expect(onChange).toHaveBeenCalledWith('allow')
  })

  it('calls onChange("block") when Block is clicked', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(
        <ToolPermissionControl
          value="allow"
          onChange={onChange}
          label="Permission for list_marts"
        />
      )
    })

    act(() => radio('Block')?.click())
    expect(onChange).toHaveBeenCalledWith('block')
  })

  it('calls onChange("ask") when Ask each time is clicked', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(
        <ToolPermissionControl
          value="allow"
          onChange={onChange}
          label="Permission for list_marts"
        />
      )
    })

    act(() => radio('Ask each time')?.click())
    expect(onChange).toHaveBeenCalledWith('ask')
  })
})
