// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorAddForm } from './ConnectorAddForm'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    addCustomServer: vi.fn().mockResolvedValue(undefined)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

// Sets a controlled input/textarea value the way React expects (native setter + input event).
const setValue = (label: string, value: string): void => {
  const field = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`
  )
  const proto =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const checkTrust = (): void => {
  const checkbox = document.body.querySelector<HTMLInputElement>(
    '[aria-label="I trust this connector"]'
  )
  act(() => checkbox?.click())
}

const addButton = (): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === 'Add connector'
  )

describe('ConnectorAddForm (local command)', () => {
  it('adds a stdio server with the default npx command, then calls onDone', async () => {
    const onDone = vi.fn()
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={onDone} onCancel={vi.fn()} />)
    })

    expect(document.body.querySelector('[aria-label="Arguments"]')?.getAttribute('data-slot')).toBe(
      'textarea'
    )
    setValue('Name', 'Memory')
    checkTrust()

    await act(async () => {
      addButton()?.click()
    })

    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Memory', transport: 'stdio', command: 'npx' })
    )
    expect(onDone).toHaveBeenCalled()
  })

  it('keeps Add connector disabled until the trust checkbox is checked', () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Name', 'Memory')
    expect(addButton()?.disabled).toBe(true)

    checkTrust()
    expect(addButton()?.disabled).toBe(false)
  })
})

describe('ConnectorAddForm (remote server)', () => {
  it('renders a Server URL field in remote mode', () => {
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    expect(document.body.querySelector('[aria-label="Server URL"]')).not.toBeNull()
  })
})

describe('ConnectorAddForm (edit)', () => {
  const editServer = {
    id: 'srv-1',
    name: 'my-mem',
    description: 'Memory server',
    transport: 'stdio' as const,
    enabled: true,
    command: 'npx',
    args: ['-y', 'old-pkg']
  }

  it('pre-fills fields, locks the name, and updates on save', async () => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      updateCustomServer: vi.fn().mockResolvedValue(undefined)
    })
    const onDone = vi.fn()
    act(() => {
      root.render(<ConnectorAddForm editServer={editServer} onDone={onDone} onCancel={vi.fn()} />)
    })

    const nameInput = document.body.querySelector<HTMLInputElement>('[aria-label="Name"]')
    expect(nameInput?.value).toBe('my-mem')
    expect(nameInput?.disabled).toBe(true) // name is immutable
    // The command Select shows the pre-filled runtime.
    expect(document.body.querySelector('[aria-label="Command"]')?.textContent).toContain('npx')

    // Edit a non-secret field.
    setValue('Description', 'Updated memory')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Save changes'
    )
    expect(save).not.toBeUndefined()

    await act(async () => {
      save?.click()
    })

    expect(useSettingsStore.getState().updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'srv-1',
        transport: 'stdio',
        command: 'npx',
        description: 'Updated memory'
      })
    )
    // No `name` is sent on edit — the name is immutable.
    const call = (useSettingsStore.getState().updateCustomServer as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(call).not.toHaveProperty('name')
    expect(onDone).toHaveBeenCalled()
  })
})
