// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { XaiOAuthSignInDialog } from './XaiOAuthSignInDialog'

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

describe('XaiOAuthSignInDialog', () => {
  it('presents the device code and a responsive verification action', () => {
    act(() => {
      root.render(
        <XaiOAuthSignInDialog
          open
          session={{
            userCode: 'GROK-2468',
            verificationUri: 'https://auth.x.ai/activate',
            verificationUriComplete: 'https://auth.x.ai/activate?user_code=GROK-2468',
            expiresAt: Date.now() + 300_000,
            intervalSeconds: 5
          }}
          onCancel={vi.fn()}
        />
      )
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('GROK-2468')
    expect(dialog?.className).toContain('w-[min(480px,92vw)]')
    expect(dialog?.querySelector<HTMLAnchorElement>('a')?.href).toContain('user_code=GROK-2468')
    expect(dialog?.textContent).toContain('Waiting for authorization…')
  })

  it('keeps cancellation available when authorization fails', () => {
    const onCancel = vi.fn()
    act(() => {
      root.render(
        <XaiOAuthSignInDialog
          open
          session={{
            userCode: 'GROK-1357',
            verificationUri: 'https://auth.x.ai/activate',
            expiresAt: Date.now() + 300_000,
            intervalSeconds: 5
          }}
          error="The xAI device code expired."
          onCancel={onCancel}
        />
      )
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('expired')
    const cancel = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Cancel'
    )
    act(() => cancel?.click())
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
