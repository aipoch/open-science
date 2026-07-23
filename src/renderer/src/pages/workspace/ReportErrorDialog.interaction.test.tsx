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

// Mutable so tests can simulate getAppInfo() resolving after the dialog has opened (appInfo starts
// undefined during early boot). Reset in beforeEach.
const updateState: { appInfo: { version: string } | undefined } = { appInfo: { version: '0.5.1' } }

vi.mock('@/stores/update-store', () => ({
  useUpdateStore: (selector: (state: typeof updateState) => unknown): unknown =>
    selector(updateState)
}))

let container: HTMLElement
let root: Root

beforeEach(() => {
  // Reset the mutable mock state so a test that mutates it (e.g. the consent-lapse tests) can't leak.
  settingsState.activeModel = 'claude-opus-4'
  updateState.appInfo = { version: '0.5.1' }
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

// Default subject matches the active config (framework claude-code, provider p1) so the environment
// preview shows the same "Anthropic · claude-opus-4" the existing assertions expect.
const renderDialog = (
  subject: { agentFrameworkId?: string; agentBackendId?: string; model?: string } = {
    agentFrameworkId: 'claude-code',
    agentBackendId: 'claude-code:p1',
    model: 'claude-opus-4'
  }
): void => {
  act(() => {
    root.render(
      <ReportErrorDialog
        open
        error="Run failed: connection reset"
        subject={subject}
        onClose={() => {}}
      />
    )
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

  it('revokes consent when a payload store field changes after consent', () => {
    renderDialog()
    act(() => {
      consentCheckbox().click()
    })
    expect(consentCheckbox().checked).toBe(true)
    expect(issueLink()?.getAttribute('href') ?? '').toContain('app-version=0.5.1')

    // A payload field changing after consent must drop consent so the user never shares data they did
    // not confirm. The model is session-scoped and intentionally unaffected by active-model changes.
    act(() => {
      updateState.appInfo = { version: '0.5.2' }
      renderDialog()
    })

    expect(consentCheckbox().checked).toBe(false)
    const href = issueLink()?.getAttribute('href')
    expect(href === null || href === undefined).toBe(true) // link disabled again
  })

  it('keeps the failed session model when the active model changes later', () => {
    renderDialog()
    settingsState.activeModel = 'model-selected-after-failure'

    act(() => renderDialog())

    expect(environmentBlock()).toContain('Provider / model: Anthropic · claude-opus-4')
    expect(environmentBlock()).not.toContain('model-selected-after-failure')
  })

  it('picks up an app version that resolves after the dialog opened (no permanent Unknown)', () => {
    // Simulate opening during early boot: getAppInfo() has not resolved yet.
    updateState.appInfo = undefined
    renderDialog()
    expect(environmentBlock()).toContain('App version: Unknown')
    expect(issueLink()?.getAttribute('href') ?? '').not.toContain('app-version')

    // getAppInfo() resolves and the store updates while the dialog is still open.
    act(() => {
      updateState.appInfo = { version: '0.5.1' }
      renderDialog()
    })

    // The live-derived context must reflect the now-known version, not a frozen Unknown.
    expect(environmentBlock()).toContain('App version: 0.5.1')
    act(() => {
      consentCheckbox().click()
    })
    expect(issueLink()?.getAttribute('href') ?? '').toContain('app-version=0.5.1')
  })

  it('attributes framework/provider to the failed session, not the current active config', () => {
    // The session failed under provider p1; the user has since switched the active provider away to a
    // provider not even in the list. The report must still name the session's provider (Anthropic), and
    // must omit the model because the active provider no longer matches the session's.
    settingsState.activeProviderId = 'p2-switched-later'
    settingsState.activeModel = 'some-other-model'
    renderDialog({ agentFrameworkId: 'claude-code', agentBackendId: 'claude-code:p1' })

    const env = environmentBlock()
    expect(env).toContain('Agent framework: Claude Code')
    // Provider from the session (p1 → Anthropic), model dropped (active provider differs now).
    expect(env).toContain('Provider / model: Anthropic')
    expect(env).not.toContain('some-other-model')

    // Restore for later tests (beforeEach also resets, but keep the mutation local in spirit).
    settingsState.activeProviderId = 'p1'
  })

  it('truncates a very long error so the GitHub URL cannot 414, keeping Copy details full', () => {
    const longError = 'x'.repeat(20000)
    act(() => {
      root.render(
        <ReportErrorDialog
          open
          error={longError}
          subject={{ agentFrameworkId: 'claude-code', agentBackendId: 'claude-code:p1' }}
          onClose={() => {}}
        />
      )
    })
    act(() => {
      consentCheckbox().click()
    })

    const href = issueLink()?.getAttribute('href') ?? ''
    // The what-happened param is bounded well under the raw 20k error length, with a visible marker.
    const whatHappened = new URL(href).searchParams.get('what-happened') ?? ''
    expect(whatHappened.length).toBeLessThan(20000)
    expect(whatHappened).toContain('truncated')

    const submittedPreview = document.body.querySelector(
      '[aria-label="GitHub issue prefill"]'
    )?.textContent
    expect(submittedPreview).toContain(whatHappened)
    expect(submittedPreview).toContain('Copy details')
  })
})
