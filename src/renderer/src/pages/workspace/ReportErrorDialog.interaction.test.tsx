// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReportErrorDialog } from './ReportErrorDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsState = {
  providers: [{ id: 'p1', name: 'Anthropic' }],
  activeProviderId: 'p1',
  activeModel: 'claude-opus-4',
  agentFrameworkId: 'claude-code',
  agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code' }]
}

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown): unknown =>
    selector(settingsState)
}))

vi.mock('@/stores/update-store', () => ({
  useUpdateStore: (selector: (state: { appInfo: { version: string } }) => unknown): unknown =>
    selector({ appInfo: { version: '0.5.1' } })
}))

let container: HTMLElement
let root: Root

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    platform: 'win32',
    getRuntimeVersions: () => ({ electron: '30.0.0', chrome: '124', node: '20.11' }),
    logs: { revealInFolder: vi.fn().mockResolvedValue({ revealed: true }) }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const renderDialog = (): void => {
  act(() => {
    root.render(<ReportErrorDialog open error="Run failed: connection reset" onClose={() => {}} />)
  })
}

// Radix renders the dialog into document.body via a portal, so query the whole document.
const issueLink = (): HTMLAnchorElement | null =>
  document.body.querySelector('a[aria-disabled]') as HTMLAnchorElement | null

const consentCheckbox = (): HTMLInputElement =>
  document.body.querySelector('input[type="checkbox"]') as HTMLInputElement

const textarea = (): HTMLTextAreaElement =>
  document.body.querySelector('textarea[aria-label="Error report preview"]') as HTMLTextAreaElement

describe('ReportErrorDialog', () => {
  it('seeds the editable textarea with error and environment on open', () => {
    renderDialog()
    const value = textarea()?.value ?? ''
    expect(value).toContain('Run failed: connection reset')
    expect(value).toContain('App version: 0.5.1')
    expect(value).toContain('Provider / model: Anthropic · claude-opus-4')
    expect(value).toContain('Operating system: Windows')
  })

  it('gates the GitHub issue action behind the consent checkbox', () => {
    renderDialog()
    expect(issueLink()?.getAttribute('aria-disabled')).toBe('true')
    expect(issueLink()?.getAttribute('href')).toBeNull()

    act(() => {
      consentCheckbox().click()
    })

    expect(issueLink()?.getAttribute('aria-disabled')).toBe('false')
    expect(issueLink()?.getAttribute('href')).toContain('/issues/new?')
    expect(issueLink()?.getAttribute('href')).toContain('template=bug_report.yml')
  })

  it('resets consent when the user edits the textarea', () => {
    renderDialog()
    act(() => {
      consentCheckbox().click()
    })
    expect(issueLink()?.getAttribute('aria-disabled')).toBe('false')

    act(() => {
      const ta = textarea()
      // React tracks the controlled value internally; set via the native setter so onChange fires.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set
      setter?.call(ta, 'redacted content')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(issueLink()?.getAttribute('aria-disabled')).toBe('true')
  })

  it('includes environment block in the GitHub issue URL logs field', () => {
    renderDialog()
    act(() => {
      consentCheckbox().click()
    })
    const href = issueLink()?.getAttribute('href') ?? ''
    const params = new URL(href).searchParams
    expect(params.get('logs')).toContain('Environment')
    expect(params.get('logs')).toContain('Claude Code')
  })

  it('surfaces an error message when the preload bridge is missing', async () => {
    ;(window as unknown as { api: unknown }).api = undefined
    renderDialog()

    await act(async () => {
      const revealBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Reveal log file')
      )
      revealBtn?.click()
    })

    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('not available')
  })
})
