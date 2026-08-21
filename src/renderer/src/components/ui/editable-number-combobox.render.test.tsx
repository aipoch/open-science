// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EditableNumberCombobox } from './editable-number-combobox'

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
})

const render = (
  onValueChange = vi.fn(),
  props: Partial<React.ComponentProps<typeof EditableNumberCombobox>> = {}
): void => {
  act(() => {
    root.render(
      <EditableNumberCombobox
        id="token-limit"
        ariaLabel="Token limit"
        value="200000"
        presets={[32_000, 64_000, 200_000]}
        onValueChange={onValueChange}
        locale="en-US"
        {...props}
      />
    )
  })
}

describe('EditableNumberCombobox', () => {
  it('exposes an editable collapsed combobox without native number or datalist chrome', () => {
    render()

    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')
    expect(input?.type).toBe('text')
    expect(input?.inputMode).toBe('numeric')
    expect(input?.getAttribute('aria-autocomplete')).toBe('none')
    expect(input?.getAttribute('aria-expanded')).toBe('false')
    expect(input?.getAttribute('list')).toBeNull()
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('opens with ArrowDown, exposes normal-weight formatted suggestions, and selects with Enter', () => {
    const onValueChange = vi.fn()
    render(onValueChange)
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')

    act(() =>
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )

    const listbox = document.body.querySelector('[role="listbox"]')
    const options = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
    expect(listbox).not.toBeNull()
    expect(options.map((option) => option.textContent)).toEqual(['32,000', '64,000', '200,000'])
    expect(options.every((option) => option.className.includes('font-normal'))).toBe(true)
    expect(input?.getAttribute('aria-expanded')).toBe('true')
    expect(input?.getAttribute('aria-activedescendant')).toBe(options[2]?.id)

    act(() => input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(onValueChange).toHaveBeenCalledWith('200000')
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('preserves arbitrary typed values and exposes error and disabled states', () => {
    const onValueChange = vi.fn()
    render(onValueChange, { value: '272000', status: 'error' })
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')

    act(() => {
      if (!input) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '300000'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onValueChange).toHaveBeenCalledWith('300000')
    expect(input?.getAttribute('aria-invalid')).toBe('true')

    render(onValueChange, { disabled: true })
    const disabledInput = container.querySelector<HTMLInputElement>('[role="combobox"]')
    expect(disabledInput?.disabled).toBe(true)
    expect(disabledInput?.getAttribute('aria-expanded')).toBe('false')
  })
})
