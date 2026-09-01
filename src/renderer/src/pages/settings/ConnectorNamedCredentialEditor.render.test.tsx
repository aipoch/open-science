// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeviceCredentialView } from '../../../../shared/settings'
import { ConnectorNamedCredentialEditor } from './ConnectorNamedCredentialEditor'
import { parseNamedCredentialText } from './connector-named-credential-parser'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

const credential: DeviceCredentialView = {
  id: 'credential-token',
  displayName: 'Example API token',
  kind: 'token',
  status: 'stored',
  needsSecret: false,
  consumerCount: 0,
  consumerNames: [],
  createdAt: 1,
  updatedAt: 1
}

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

const setInputValue = (field: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const selectOption = (label: string, option: string): void => {
  const trigger = document.body.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent?.includes(option)
  )
  act(() => {
    item?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('parseNamedCredentialText', () => {
  it('preserves environment names while detecting invalid and duplicate lines', () => {
    expect(
      parseNamedCredentialText('API_TOKEN=ignored\nBROKEN\nAPI_TOKEN=also-ignored', 'environment')
    ).toEqual({
      values: { API_TOKEN: 'also-ignored' },
      invalidLines: [2],
      duplicateLines: [{ line: 3, name: 'API_TOKEN' }]
    })
  })

  it('treats header names case-insensitively', () => {
    expect(parseNamedCredentialText('Authorization:\nauthorization:', 'header')).toEqual({
      values: { Authorization: '' },
      invalidLines: [],
      duplicateLines: [{ line: 2, name: 'authorization' }]
    })
  })
})

describe('ConnectorNamedCredentialEditor', () => {
  it('edits names in fields mode and preserves the same source in text mode', () => {
    const Harness = (): React.JSX.Element => {
      const [text, setText] = useState('')
      return (
        <ConnectorNamedCredentialEditor
          kind="environment"
          text={text}
          onTextChange={setText}
          credentials={[credential]}
          credentialIdForName={() => undefined}
          onCredentialChange={() => undefined}
          onNameChange={() => undefined}
          onRemoveName={() => undefined}
          onCreateCredential={() => undefined}
        />
      )
    }
    act(() => root.render(<Harness />))

    const name = document.body.querySelector<HTMLInputElement>('[aria-label="Variable name"]')!
    act(() => name.focus())
    setInputValue(name, 'API_TOKEN')
    expect(document.activeElement).toBe(name)
    expect(document.body.textContent).toContain('Select credential')

    const textMode = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Environment variable editor mode"] [role="radio"]'
      )
    ).find((radio) => radio.textContent?.trim() === 'Text')
    act(() => textMode?.click())
    expect(
      document.body.querySelector<HTMLTextAreaElement>('[aria-label="Environment variables"]')
        ?.value
    ).toBe('API_TOKEN=')
  })

  it('selects or creates a Credential for the active row', () => {
    const onCredentialChange = vi.fn()
    const onCreateCredential = vi.fn()
    act(() => {
      root.render(
        <ConnectorNamedCredentialEditor
          kind="header"
          text="Authorization: "
          onTextChange={() => undefined}
          credentials={[credential]}
          credentialIdForName={() => undefined}
          onCredentialChange={onCredentialChange}
          onNameChange={() => undefined}
          onRemoveName={() => undefined}
          onCreateCredential={onCreateCredential}
        />
      )
    })

    selectOption('Credential for Authorization', 'Example API token')
    expect(onCredentialChange).toHaveBeenCalledWith('Authorization', credential.id)

    selectOption('Credential for Authorization', 'New credential')
    expect(onCreateCredential).toHaveBeenCalledWith('Authorization')
  })

  it('canonicalizes field names before moving credential bindings', () => {
    const onTextChange = vi.fn()
    const onNameChange = vi.fn()
    act(() => {
      root.render(
        <ConnectorNamedCredentialEditor
          kind="environment"
          text="OLD_TOKEN="
          onTextChange={onTextChange}
          credentials={[credential]}
          credentialIdForName={() => credential.id}
          onCredentialChange={() => undefined}
          onNameChange={onNameChange}
          onRemoveName={() => undefined}
          onCreateCredential={() => undefined}
        />
      )
    })

    setInputValue(
      document.body.querySelector<HTMLInputElement>('[aria-label="Variable name"]')!,
      ' API_TOKEN '
    )

    expect(onTextChange).toHaveBeenCalledWith('API_TOKEN=')
    expect(onNameChange).toHaveBeenCalledWith('OLD_TOKEN', 'API_TOKEN')
  })

  it('clears a reused selector when the remaining row is unbound', () => {
    const Harness = (): React.JSX.Element => {
      const [text, setText] = useState('FIRST=\nSECOND=')
      return (
        <ConnectorNamedCredentialEditor
          kind="environment"
          text={text}
          onTextChange={setText}
          credentials={[credential]}
          credentialIdForName={(name) => (name === 'FIRST' ? credential.id : undefined)}
          onCredentialChange={() => undefined}
          onNameChange={() => undefined}
          onRemoveName={() => undefined}
          onCreateCredential={() => undefined}
        />
      )
    }
    act(() => root.render(<Harness />))

    const removeFirst = document.body.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Remove variable"]'
    )[0]
    act(() => removeFirst?.click())

    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Credential for SECOND"]')
        ?.textContent
    ).toContain('Select credential')
  })

  it('explains malformed empty-name lines in fields mode', () => {
    act(() => {
      root.render(
        <ConnectorNamedCredentialEditor
          kind="environment"
          text="=secret"
          onTextChange={() => undefined}
          credentials={[credential]}
          credentialIdForName={() => undefined}
          onCredentialChange={() => undefined}
          onNameChange={() => undefined}
          onRemoveName={() => undefined}
          onCreateCredential={() => undefined}
        />
      )
    })

    expect(document.body.textContent).toContain('Line 1: use KEY=.')
    expect(
      document.body
        .querySelector<HTMLInputElement>('[aria-label="Variable name"]')
        ?.getAttribute('aria-invalid')
    ).toBe('true')
  })

  it('keeps a newly added blank field neutral while it is being named', () => {
    const Harness = (): React.JSX.Element => {
      const [text, setText] = useState('API_TOKEN=')
      return (
        <ConnectorNamedCredentialEditor
          kind="environment"
          text={text}
          onTextChange={setText}
          credentials={[credential]}
          credentialIdForName={() => undefined}
          onCredentialChange={() => undefined}
          onNameChange={() => undefined}
          onRemoveName={() => undefined}
          onCreateCredential={() => undefined}
        />
      )
    }
    act(() => root.render(<Harness />))

    const add = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Add variable')
    )
    act(() => add?.click())

    expect(document.body.querySelectorAll('[aria-label="Variable name"]')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Line 2: use KEY=.')
  })
})
