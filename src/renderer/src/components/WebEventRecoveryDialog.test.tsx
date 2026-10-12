// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  configureComposerDraftStorage,
  writeComposerDraft,
  revokeComposerDraftStorage
} from '@/pages/workspace/composer-draft-storage'

import { WebEventRecoveryDialog } from './WebEventRecoveryDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  revokeComposerDraftStorage()
  sessionStorage.clear()
})

describe('WebEventRecoveryDialog', () => {
  it('exposes a copyable fallback and blocks reload until the copy is saved when quota is exhausted', async () => {
    configureComposerDraftStorage('scope')
    vi.spyOn(Object.getPrototypeOf(sessionStorage), 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    writeComposerDraft('project', 'session', {
      doc: { nodes: [{ type: 'text', text: 'copy this draft' }] },
      annotations: [],
      attachments: [],
      attachmentTransfers: [],
      automaticReadingEnabled: true
    })
    await act(async () => root.render(<WebEventRecoveryDialog active phase="reload-required" />))
    const button = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Reload'
    )!
    expect(button.disabled).toBe(true)
    expect(document.body.querySelector('textarea')?.value).toContain('copy this draft')
    await act(async () =>
      document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    )
    expect(button.disabled).toBe(false)
  })

  it('identifies the connection host and explains how to pair again without a retry loop', async () => {
    await act(async () =>
      root.render(<WebEventRecoveryDialog active phase="authorization-required" />)
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Pairing required')
    expect(dialog.textContent).toContain('Host')
    expect(dialog.textContent).toContain(window.location.host)
    expect(dialog.textContent).toContain('pair again')
    expect(dialog.querySelector('button')).toBeNull()
    expect(dialog.querySelector('.animate-spin')).toBeNull()
  })

  it('offers a recovery action while an ordinary reconnect is pending', async () => {
    await act(async () => {
      root.render(<WebEventRecoveryDialog active phase="reconnecting" />)
    })

    await act(async () => vi.advanceTimersByTime(5000))
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Reconnecting to Open-Science')
    expect(
      Array.from(dialog?.querySelectorAll('button') ?? []).some(
        (button) => button.textContent === 'Reload'
      )
    ).toBe(true)
  })

  it('blocks stale interaction while replay is in progress without offering an unsafe bypass', async () => {
    await act(async () => {
      root.render(<WebEventRecoveryDialog active phase="replaying" />)
    })

    await act(async () => vi.advanceTimersByTime(5000))
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

describe('recovery waiting presentation', () => {
  it('continues the startup particle surface until the first live connection', async () => {
    await act(async () => root.render(<WebEventRecoveryDialog active phase="connecting" />))
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('[data-testid="open-science-logo-loader"]')).not.toBeNull()
    expect(dialog.querySelector('.animate-spin')).toBeNull()
    expect(dialog.previousElementSibling?.className).toContain('bg-background')
    expect(dialog.previousElementSibling?.className).not.toContain('bg-background/80')
    await act(async () => root.render(<WebEventRecoveryDialog active phase="replaying" />))
    expect(dialog.querySelector('[data-testid="open-science-logo-loader"]')).not.toBeNull()
  })

  it('keeps later reconnect and replay lightweight instead of restarting the startup logo', async () => {
    await act(async () => root.render(<WebEventRecoveryDialog active={false} phase="live" />))
    for (const phase of ['reconnecting', 'replaying'] as const) {
      await act(async () => root.render(<WebEventRecoveryDialog active phase={phase} />))
      const dialog = document.body.querySelector('[role="dialog"]')!
      expect(dialog.querySelector('[data-testid="open-science-logo-loader"]')).toBeNull()
      expect(dialog.querySelector('.animate-spin')).not.toBeNull()
      expect(dialog.previousElementSibling?.className).toContain('bg-background/80')
    }
  })

  it('does not open a recovery alert during an immediately successful connection', async () => {
    await act(async () => root.render(<WebEventRecoveryDialog active phase="connecting" />))
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('Connecting')
    await act(async () => root.render(<WebEventRecoveryDialog active={false} phase="live" />))
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('counts one continuous wait across connection phases and resets after recovery', async () => {
    await act(async () => root.render(<WebEventRecoveryDialog active phase="connecting" />))
    await act(async () => vi.advanceTimersByTime(3000))
    await act(async () => root.render(<WebEventRecoveryDialog active phase="reconnecting" />))
    await act(async () => vi.advanceTimersByTime(1999))
    await act(async () => root.render(<WebEventRecoveryDialog active phase="replaying" />))
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('Restoring')
    await act(async () => vi.advanceTimersByTime(1))
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain('Restoring')
    await act(async () => root.render(<WebEventRecoveryDialog active={false} phase="live" />))
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Reload required')
    await act(async () => root.render(<WebEventRecoveryDialog active phase="reconnecting" />))
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    await act(async () => vi.advanceTimersByTime(4999))
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    await act(async () => vi.advanceTimersByTime(1))
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
  })

  it('does not restart the deadline when another presentation takes priority', async () => {
    await act(async () => root.render(<WebEventRecoveryDialog active phase="reconnecting" />))
    await act(async () => vi.advanceTimersByTime(3000))
    await act(async () =>
      root.render(<WebEventRecoveryDialog active={false} phase="reconnecting" />)
    )
    await act(async () => vi.advanceTimersByTime(2000))
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    await act(async () => root.render(<WebEventRecoveryDialog active phase="reconnecting" />))
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
  })

  it.each(['authorization-required', 'reload-required'] as const)(
    'shows %s immediately during the wait',
    async (phase) => {
      await act(async () => root.render(<WebEventRecoveryDialog active phase="connecting" />))
      await act(async () => root.render(<WebEventRecoveryDialog active phase={phase} />))
      expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
      expect(document.body.querySelector('[role="status"]')).toBeNull()
    }
  )

  it('cancels escalation when unmounted and when a connection recovers quickly', async () => {
    await act(async () => root.render(<WebEventRecoveryDialog active phase="connecting" />))
    await act(async () => vi.advanceTimersByTime(100))
    await act(async () => root.render(<WebEventRecoveryDialog active={false} phase="live" />))
    await act(async () => vi.advanceTimersByTime(5000))
    expect(document.body.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
    await act(async () => root.render(<WebEventRecoveryDialog active phase="reconnecting" />))
    await act(async () => root.render(null))
    await act(async () => vi.advanceTimersByTime(5000))
    expect(vi.getTimerCount()).toBe(0)
    expect(document.body.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
  })
  it('moves focus inside the loading modal and restores it after the shell removes inert', async () => {
    const render = async (recovering: boolean): Promise<void> => {
      await act(async () =>
        root.render(
          <>
            <div inert={recovering}>
              <button>Continue research</button>
            </div>
            <WebEventRecoveryDialog
              active={recovering}
              phase={recovering ? 'connecting' : 'live'}
            />
          </>
        )
      )
    }
    await render(false)
    const button = container.querySelector('button')!
    button.focus()
    await render(true)
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(button.closest('[inert]')).not.toBeNull()
    await render(false)
    await act(async () => vi.advanceTimersByTime(0))
    expect(document.activeElement).toBe(button)
  })
})
