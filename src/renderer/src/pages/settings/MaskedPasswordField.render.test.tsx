// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MaskedPasswordField } from './MaskedPasswordField'

let container: HTMLDivElement
let root: Root

const clipboardEvent = (type: 'copy' | 'cut' | 'paste', text: string): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: vi.fn(() => text),
      setData: vi.fn()
    }
  })
  return event
}

const beforeInput = (inputType: string, data: string | null = null): InputEvent =>
  new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data })

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MaskedPasswordField', () => {
  it('keeps raw multiline credentials out of the DOM and accessibility-facing value', () => {
    const exact = `  "quoted" 'single'\n第二行🙂\n${'x'.repeat(4096)}  `
    let submitted = ''
    const Harness = (): React.JSX.Element => {
      const [value, setValue] = useState('')
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submitted = value
          }}
        >
          <span id="password-error">Password is required.</span>
          <MaskedPasswordField
            id="password"
            aria-label="Password"
            aria-invalid
            aria-describedby="password-error"
            value={value}
            onChange={setValue}
          />
          <button type="submit">Save</button>
        </form>
      )
    }
    act(() => root.render(<Harness />))
    const password = container.querySelector<HTMLInputElement>('#password')!

    act(() => password.dispatchEvent(clipboardEvent('paste', exact)))

    expect(password.type).toBe('password')
    expect(password.value).toBe('•'.repeat(exact.length))
    expect(password.value).not.toContain(exact)
    expect(container.innerHTML).not.toContain(exact)
    expect(password.getAttribute('aria-invalid')).toBe('true')
    expect(password.getAttribute('aria-describedby')).toBe('password-error')

    act(() => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(submitted).toBe(exact)
  })

  it('maps selection edits, Enter, backward delete, and forward delete onto the raw value', () => {
    let current = ''
    act(() =>
      root.render(
        <MaskedPasswordField
          id="password"
          value={current}
          onChange={(value) => (current = value)}
        />
      )
    )
    const password = container.querySelector<HTMLInputElement>('#password')!
    const paste = (text: string): void => {
      act(() => password.dispatchEvent(clipboardEvent('paste', text)))
      act(() =>
        root.render(
          <MaskedPasswordField
            id="password"
            value={current}
            onChange={(value) => (current = value)}
          />
        )
      )
    }
    const edit = (inputType: string, data: string | null = null): void => {
      act(() => password.dispatchEvent(beforeInput(inputType, data)))
      act(() =>
        root.render(
          <MaskedPasswordField
            id="password"
            value={current}
            onChange={(value) => (current = value)}
          />
        )
      )
    }

    paste('ab🙂cd')
    password.setSelectionRange(2, 4)
    edit('insertText', '界')
    expect(current).toBe('ab界cd')

    password.setSelectionRange(3, 3)
    act(() =>
      password.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })
      )
    )
    act(() =>
      root.render(
        <MaskedPasswordField
          id="password"
          value={current}
          onChange={(value) => (current = value)}
        />
      )
    )
    expect(current).toBe('ab界\ncd')

    password.setSelectionRange(4, 4)
    edit('deleteContentBackward')
    expect(current).toBe('ab界cd')

    password.setSelectionRange(2, 2)
    edit('deleteContentForward')
    expect(current).toBe('abcd')
    expect(password.value).toBe('••••')
  })

  it('prevents copy and cut from exposing or removing the raw credential', () => {
    const raw = 'private\n秘密🙂'
    act(() => root.render(<MaskedPasswordField id="password" value={raw} onChange={vi.fn()} />))
    const password = container.querySelector<HTMLInputElement>('#password')!
    password.select()
    const copy = clipboardEvent('copy', '')
    const cut = clipboardEvent('cut', '')

    expect(password.dispatchEvent(copy)).toBe(false)
    expect(password.dispatchEvent(cut)).toBe(false)
    expect((copy as ClipboardEvent).clipboardData?.setData).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('private')
    )
    expect((cut as ClipboardEvent).clipboardData?.setData).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('private')
    )
    expect(password.value).toBe('•'.repeat(raw.length))
  })

  it('commits an IME composition once without placing composition text in the DOM', () => {
    let current = 'ab'
    act(() =>
      root.render(
        <MaskedPasswordField
          id="password"
          value={current}
          onChange={(value) => (current = value)}
        />
      )
    )
    const password = container.querySelector<HTMLInputElement>('#password')!
    password.setSelectionRange(1, 1)

    act(() => {
      password.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      password.dispatchEvent(beforeInput('insertCompositionText', '界'))
      expect(password.value).toBe('••')
      password.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '界' }))
      password.dispatchEvent(beforeInput('insertFromComposition', '界'))
    })
    act(() =>
      root.render(
        <MaskedPasswordField
          id="password"
          value={current}
          onChange={(value) => (current = value)}
        />
      )
    )

    expect(current).toBe('a界b')
    expect(password.value).toBe('•••')
  })
})
