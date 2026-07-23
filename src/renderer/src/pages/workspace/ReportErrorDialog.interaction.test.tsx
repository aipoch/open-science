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
  // Reset the mutable mock state so a test that mutates it (e.g. the snapshot-freeze test) can't leak.
  settingsState.activeModel = 'claude-opus-4'
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
  document.body.querySelector('textarea[aria-label="Error details"]') as HTMLTextAreaElement

const environmentBlock = (): string =>
  document.body.querySelector('[aria-label="Report environment"]')?.textContent ?? ''

describe('ReportErrorDialog', () => {
  it('seeds the editable textarea with only the error text', () => {
    renderDialog()
    expect(textarea()?.value).toBe('Run failed: connection reset')
  })

  it('shows environment facts read-only, outside the editable field', () => {
    renderDialog()
    const env = environmentBlock()
    expect(env).toContain('App version: 0.5.1')
    expect(env).toContain('Provider / model: Anthropic · claude-opus-4')
    expect(env).toContain('Operating system: Windows')
    // Environment must not be duplicated inside the editable error field.
    expect(textarea()?.value).not.toContain('App version')
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

  it('carries framework/runtime into the logs field without duplicating structured fields', () => {
    renderDialog()
    act(() => {
      consentCheckbox().click()
    })
    const params = new URL(issueLink()?.getAttribute('href') ?? '').searchParams
    expect(params.get('logs')).toContain('Claude Code')
    expect(params.get('logs')).not.toContain('App version')
    expect(params.get('what-happened')).toBe('Run failed: connection reset')
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

  it('surfaces an inline message when the reveal IPC call rejects', async () => {
    ;(window as unknown as { api: { logs: { revealInFolder: () => Promise<unknown> } } }).api = {
      logs: { revealInFolder: vi.fn().mockRejectedValue(new Error('IPC channel closed')) }
    } as never

    renderDialog()

    await act(async () => {
      const revealBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Reveal log file')
      )
      revealBtn?.click()
      // Let the rejected promise settle before assertions.
      await Promise.resolve()
    })

    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('IPC channel closed')
  })

  it('freezes the context at open so a later store change cannot alter the consented report', () => {
    renderDialog()
    act(() => {
      consentCheckbox().click()
    })
    const before = issueLink()?.getAttribute('href') ?? ''
    expect(before).toContain('claude-opus-4')

    // Simulate an async store update landing after the user consented (e.g. getAppInfo resolving),
    // then a re-render. The mounted dialog must keep its snapshot: no new field enters the shared
    // URL, and consent is not silently carried onto content the user never reviewed.
    act(() => {
      settingsState.activeModel = 'claude-sneaky-swap'
      renderDialog()
    })

    const after = issueLink()?.getAttribute('href') ?? ''
    expect(after).toBe(before)
    expect(after).not.toContain('claude-sneaky-swap')
    expect(consentCheckbox().checked).toBe(true)
  })
})
