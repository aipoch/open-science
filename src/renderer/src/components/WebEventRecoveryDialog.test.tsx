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
  vi.restoreAllMocks()
  revokeComposerDraftStorage()
  sessionStorage.clear()
})

describe('WebEventRecoveryDialog', () => {
  it('exposes a copyable fallback and blocks reload until the copy is saved when quota is exhausted', async () => {
    configureComposerDraftStorage('scope')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
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

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Reconnecting to Open Science')
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
