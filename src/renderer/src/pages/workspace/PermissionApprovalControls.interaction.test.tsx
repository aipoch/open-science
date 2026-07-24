// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpPermissionRequest } from '../../../../shared/acp'
import { PermissionApprovalControls } from './PermissionApprovalControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const baseRequest: AcpPermissionRequest = {
  requestId: 'req-1',
  sessionId: 'session-1',
  toolCallId: 'tool-1',
  title: 'ls -la',
  providerToolName: 'Bash',
  toolKind: 'execute',
  rawInput: { command: 'ls -la' },
  options: [
    { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'opt-always', name: 'Always', kind: 'allow_always' },
    { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' }
  ],
  raw: {}
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
})

describe('PermissionApprovalControls interactions', () => {
  it('default Allow button uses the narrowest scope (this call only), not the standing grant', () => {
    // Least-privilege: the easiest click must be the one-time approval, not a persistent grant.
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={vi.fn()} />)
    })
    expect(container.textContent).toContain('this call only')
    expect(container.textContent).not.toContain('this conversation')
  })

  it('Allow with default scope calls onRespond with the allow_once optionId', () => {
    const onRespond = vi.fn()
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={onRespond} />)
    })
    const allowBtn = container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement
    act(() => allowBtn.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-once')
  })

  it('switching to Once updates button label and calls allow_once optionId', () => {
    const onRespond = vi.fn()
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={onRespond} />)
    })
    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement
    act(() => chevron.click())
    const onceItem = Array.from(container.querySelectorAll('[role="menuitemradio"]')).find(
      (el) => el.textContent?.includes('Once') && !el.textContent?.includes('conversation')
    ) as HTMLElement
    act(() => onceItem.click())
    expect(container.textContent).toContain('this call')
    const allowBtn = container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement
    act(() => allowBtn.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-once')
  })

  it('allow-always-only request never falls back to allow_always when scope is once', () => {
    const onRespond = vi.fn()
    // Only a conversation-scope option exists; "once" must not borrow it.
    const alwaysOnly: AcpPermissionRequest = {
      ...baseRequest,
      options: [
        { optionId: 'opt-always', name: 'Always', kind: 'allow_always' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' }
      ]
    }
    act(() => {
      root.render(<PermissionApprovalControls requests={[alwaysOnly]} onRespond={onRespond} />)
    })
    // Defaults to the available conversation scope.
    expect(container.textContent).toContain('this conversation')
    // The scope menu offers only the supported scope (no "Once" item).
    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement
    act(() => chevron.click())
    const items = Array.from(container.querySelectorAll('[role="menuitemradio"]'))
    expect(items.some((el) => el.textContent?.includes('This conversation'))).toBe(true)
    expect(
      items.some(
        (el) => el.textContent?.includes('Once') && !el.textContent?.includes('conversation')
      )
    ).toBe(false)
    // Allowing sends the conversation option, never a mislabeled once grant.
    const allowBtn = container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement
    act(() => allowBtn.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-always')
  })

  it('renders the full command from title when rawInput is absent', () => {
    const noRawInput: AcpPermissionRequest = {
      ...baseRequest,
      title: 'rm -rf ./build && echo done',
      rawInput: undefined
    }
    act(() => {
      root.render(<PermissionApprovalControls requests={[noRawInput]} onRespond={vi.fn()} />)
    })
    const codeBlock = container.querySelector('[data-testid="tool-code-block"]')
    expect(codeBlock?.textContent).toContain('rm -rf ./build && echo done')
  })

  it('renders tool locations so the affected path is visible before approval', () => {
    const withLocation: AcpPermissionRequest = {
      ...baseRequest,
      title: 'Edit',
      providerToolName: 'Edit',
      toolKind: 'edit',
      rawInput: undefined,
      toolLocations: [{ path: '/repo/src/secret-config.ts' }]
    }
    act(() => {
      root.render(<PermissionApprovalControls requests={[withLocation]} onRespond={vi.fn()} />)
    })
    expect(container.textContent).toContain('/repo/src/secret-config.ts')
  })

  it('Deny prefers reject_once even when reject_always is listed first', () => {
    const onRespond = vi.fn()
    // Provider lists a permanent reject before the one-time reject; Deny must pick reject_once.
    const bothRejects: AcpPermissionRequest = {
      ...baseRequest,
      options: [
        { optionId: 'opt-always', name: 'Always', kind: 'allow_always' },
        { optionId: 'opt-reject-always', name: 'Reject always', kind: 'reject_always' },
        { optionId: 'opt-reject-once', name: 'Reject once', kind: 'reject_once' }
      ]
    }
    act(() => {
      root.render(<PermissionApprovalControls requests={[bothRejects]} onRespond={onRespond} />)
    })
    const denyBtn = container.querySelector('[data-testid="deny-button"]') as HTMLButtonElement
    act(() => denyBtn.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-reject-once')
  })

  it('clicking a non-canonical extra option sends its exact optionId', () => {
    const onRespond = vi.fn()
    const withCustom: AcpPermissionRequest = {
      ...baseRequest,
      options: [
        { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
        { optionId: 'opt-sandbox', name: 'Run in sandbox', kind: 'allow_sandbox' }
      ]
    }
    act(() => {
      root.render(<PermissionApprovalControls requests={[withCustom]} onRespond={onRespond} />)
    })
    const extra = container.querySelector('[data-testid="extra-option"]') as HTMLButtonElement
    expect(extra?.textContent).toContain('Run in sandbox')
    act(() => extra.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-sandbox')
  })

  it('closes the scope menu when Escape is pressed', () => {
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={vi.fn()} />)
    })
    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement
    act(() => chevron.click())
    expect(container.querySelector('[role="menuitemradio"]')).not.toBeNull()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull()
  })

  it('focuses and navigates scope choices from the keyboard', async () => {
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={vi.fn()} />)
    })
    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement

    await act(async () => {
      chevron.click()
    })
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    )
    expect(document.activeElement).toBe(items[0])

    act(() => {
      items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(items[1])

    act(() => {
      items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(container.textContent).toContain('this conversation')
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull()

    act(() => chevron.click())
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(chevron)
  })

  it('Deny calls onRespond with reject optionId', () => {
    const onRespond = vi.fn()
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={onRespond} />)
    })
    const denyBtn = container.querySelector('[data-testid="deny-button"]') as HTMLButtonElement
    act(() => denyBtn.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-reject')
  })

  it('Deny without a reject option calls onRespond with undefined', () => {
    const onRespond = vi.fn()
    const noReject = {
      ...baseRequest,
      options: baseRequest.options.filter((o) => !o.kind.startsWith('reject'))
    }
    act(() => {
      root.render(<PermissionApprovalControls requests={[noReject]} onRespond={onRespond} />)
    })
    const denyBtn = container.querySelector('[data-testid="deny-button"]') as HTMLButtonElement
    act(() => denyBtn.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', undefined)
  })

  it('code card is expanded by default and toggles closed on header click', () => {
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={vi.fn()} />)
    })
    // Card starts expanded: code block is visible.
    expect(container.querySelector('[data-testid="tool-code-block"]')).not.toBeNull()
    const toggle = container.querySelector(
      '[data-testid="permission-code-toggle"]'
    ) as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // Clicking the header collapses the code block.
    act(() => toggle.click())
    expect(container.querySelector('[data-testid="tool-code-block"]')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('resets scope, open menu, and expand state when the next request is shown', () => {
    // Switch req-1 to Conversation (away from the default Once) and leave the menu open, then swap
    // to a fresh request to verify all state resets.
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={vi.fn()} />)
    })
    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement
    act(() => chevron.click())
    const convItem = Array.from(container.querySelectorAll('[role="menuitemradio"]')).find((el) =>
      el.textContent?.includes('This conversation')
    ) as HTMLElement
    act(() => convItem.click())
    // Collapse the code card so we can prove it re-expands for the next request.
    const toggle = container.querySelector(
      '[data-testid="permission-code-toggle"]'
    ) as HTMLButtonElement
    act(() => toggle.click())
    expect(container.textContent).toContain('this conversation')
    expect(container.querySelector('[data-testid="tool-code-block"]')).toBeNull()

    // Rerender with a different request as the head of the queue.
    const nextRequest: AcpPermissionRequest = {
      ...baseRequest,
      requestId: 'req-2',
      title: 'cat /etc/hosts',
      rawInput: { command: 'cat /etc/hosts' }
    }
    act(() => {
      root.render(<PermissionApprovalControls requests={[nextRequest]} onRespond={vi.fn()} />)
    })
    // Scope reset to the default (once), menu closed, card re-expanded.
    expect(container.textContent).toContain('this call only')
    expect(container.textContent).not.toContain('this conversation')
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull()
    const nextToggle = container.querySelector(
      '[data-testid="permission-code-toggle"]'
    ) as HTMLButtonElement
    expect(nextToggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="tool-code-block"]')?.textContent).toContain(
      'cat /etc/hosts'
    )
  })

  it('opens the scope menu via keyboard-driven click activation', () => {
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={vi.fn()} />)
    })
    // Enter/Space on a native button dispatches a click, not mousedown.
    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull()
    act(() => chevron.click())
    expect(container.querySelector('[role="menuitemradio"]')).not.toBeNull()
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
  })
})
