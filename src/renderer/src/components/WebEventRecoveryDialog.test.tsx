// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WebEventRecoveryDialog } from './WebEventRecoveryDialog'

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

describe('WebEventRecoveryDialog', () => {
  it('blocks stale interaction while replay is in progress without offering an unsafe bypass', async () => {
    await act(async () => {
      root.render(<WebEventRecoveryDialog active phase="replaying" />)
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Restoring missed updates')
    expect(dialog?.textContent).not.toContain('Reload')
  })

  it('offers an explicit reload when the event suffix cannot be recovered', async () => {
    await act(async () => {
      root.render(<WebEventRecoveryDialog active phase="reload-required" />)
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Reload required')
    expect(
      Array.from(dialog?.querySelectorAll('button') ?? []).some(
        (button) => button.textContent === 'Reload'
      )
    ).toBe(true)
  })
})
