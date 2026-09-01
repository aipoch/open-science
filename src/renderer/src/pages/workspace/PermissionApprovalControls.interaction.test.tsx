// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpPermissionRequest } from '../../../../shared/acp'
import { i18next } from '@/i18n'
import { PermissionApprovalControls } from './PermissionApprovalControls'
import { PermissionScopeConfirmationDialog } from './PermissionScopeConfirmationDialog'

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
  ]
}

const networkApprovalRequest: AcpPermissionRequest = {
  requestId: 'network-1',
  sessionId: 'session-1',
  toolCallId: 'app-approval:network-1',
  title: 'Connect to data.example.org?',
  appOwned: true,
  providerToolName: 'Open Science',
  rawInput: {
    notebookNetworkApproval: { hostname: 'data.example.org', port: 443, runtime: 'python' }
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
    {
      optionId: 'always-allow',
      name: 'Global',
      kind: 'allow_always',
      scope: 'global'
    },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
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
  it('routes persistent network access through the standard Global approval scope', () => {
    const onRespond = vi.fn()
    act(() => {
      root.render(
        <PermissionApprovalControls requests={[networkApprovalRequest]} onRespond={onRespond} />
      )
    })

    const details = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Details')
    )
    expect(details).toBeDefined()
    act(() => details?.click())
    expect(container.textContent).toContain(
      'Only allow domains you trust. You can revoke saved access anytime in Settings > Network > Allowed domains.'
    )

    expect(container.querySelector('[data-testid="extra-option"]')).toBeNull()
    act(() =>
      (container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement).click()
    )
    const global = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent?.includes('Global'))
    expect(global).toBeDefined()
    act(() => global?.click())
    expect(container.querySelector('[data-testid="allow-primary"]')?.textContent).toBe(
      'Allow globally'
    )
    act(() =>
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).click()
    )
    expect(onRespond).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Allow data.example.org globally?')
    expect(document.body.textContent).toContain('Settings → Network → Allowed domains')
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="permission-scope-confirm"]')
        ?.click()
    )
    expect(onRespond).toHaveBeenCalledWith('network-1', 'always-allow')
  })

  it('renders broad Korean permission scopes as natural complete titles', async () => {
    await act(async () => i18next.changeLanguage('ko'))
    try {
      act(() => {
        root.render(
          <PermissionScopeConfirmationDialog
            confirmation={{ scope: 'project', subject: '명령 그룹', codeExecution: true }}
            onCancel={() => undefined}
            onConfirm={() => undefined}
          />
        )
      })
      expect(document.body.textContent).toContain(
        '이 프로젝트에서 명령 그룹 사용을 허용하시겠습니까?'
      )

      act(() => {
        root.render(
          <PermissionScopeConfirmationDialog
            confirmation={{ scope: 'global', subject: '명령 그룹', codeExecution: true }}
            onCancel={() => undefined}
            onConfirm={() => undefined}
          />
        )
      })
      expect(document.body.textContent).toContain(
        '모든 프로젝트에서 명령 그룹 사용을 허용하시겠습니까?'
      )
    } finally {
      await act(async () => i18next.changeLanguage('en'))
    }
  })

  it('renders delegated permission cards independently with child, action, scope, and focus labels', () => {
    const onRespond = vi.fn(() => new Promise<void>(() => undefined))
    const alpha: AcpPermissionRequest = {
      ...baseRequest,
      requestId: 'permission-alpha',
      title: 'Read alpha.csv',
      delegated: {
        frameId: 'frame-alpha',
        attemptId: 'attempt-alpha',
        childTitle: 'Alpha child',
        riskScope: 'This call only'
      }
    }
    const beta: AcpPermissionRequest = {
      ...baseRequest,
      requestId: 'permission-beta',
      title: 'Run beta check',
      delegated: {
        frameId: 'frame-beta',
        attemptId: 'attempt-beta',
        childTitle: 'Beta child',
        riskScope: 'This session or this call'
      }
    }

    act(() => {
      root.render(<PermissionApprovalControls requests={[alpha, beta]} onRespond={onRespond} />)
    })

    const cards = container.querySelectorAll('[data-testid="permission-card"]')
    expect(cards).toHaveLength(2)
    expect(cards[0].getAttribute('aria-label')).toContain('Alpha child')
    expect(cards[0].textContent).toContain('Read alpha.csv')
    expect(cards[0].textContent).toContain('This call only')
    expect(cards[1].getAttribute('aria-label')).toContain('Beta child')
    expect(cards[1].textContent).toContain('This session or this call')

    const allowButtons = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="allow-primary"]'
    )
    act(() => allowButtons[0].click())
    expect(allowButtons[0].disabled).toBe(true)
    expect(allowButtons[1].disabled).toBe(false)
    act(() => allowButtons[1].click())
    expect(onRespond).toHaveBeenCalledWith('permission-alpha', 'opt-always')
    expect(onRespond).toHaveBeenCalledWith('permission-beta', 'opt-always')
  })

  it('disables every unresolved card only while root Stop submission is pending', () => {
    const delegated: AcpPermissionRequest = {
      ...baseRequest,
      delegated: {
        frameId: 'frame-1',
        attemptId: 'attempt-1',
        childTitle: 'Risk auditor',
        riskScope: 'This call only'
      }
    }
    act(() => {
      root.render(
        <PermissionApprovalControls requests={[delegated]} onRespond={vi.fn()} disabled />
      )
    })
    expect(
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (container.querySelector('[data-testid="deny-button"]') as HTMLButtonElement).disabled
    ).toBe(true)

    act(() => {
      root.render(
        <PermissionApprovalControls requests={[delegated]} onRespond={vi.fn()} disabled={false} />
      )
    })
    expect(
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('returns keyboard focus to the next child card after a response clears', async () => {
    const alpha: AcpPermissionRequest = {
      ...baseRequest,
      requestId: 'focus-alpha',
      delegated: {
        frameId: 'frame-alpha',
        attemptId: 'attempt-alpha',
        childTitle: 'Alpha child',
        riskScope: 'This call only'
      }
    }
    const beta: AcpPermissionRequest = {
      ...baseRequest,
      requestId: 'focus-beta',
      delegated: {
        frameId: 'frame-beta',
        attemptId: 'attempt-beta',
        childTitle: 'Beta child',
        riskScope: 'This call only'
      }
    }
    const onRespond = vi.fn()
    act(() => {
      root.render(<PermissionApprovalControls requests={[alpha, beta]} onRespond={onRespond} />)
    })
    const firstAllow = container.querySelector<HTMLButtonElement>('[data-testid="allow-primary"]')!
    act(() => firstAllow.click())
    act(() => {
      root.render(<PermissionApprovalControls requests={[beta]} onRespond={onRespond} />)
    })
    await act(async () => Promise.resolve())

    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('[data-testid="allow-primary"]')
    )
  })

  it('default Allow button uses the Session scope so a repeated tool does not re-prompt', () => {
    // The easiest click approves for the logical Session; narrowing to a one-time
    // approval is an explicit choice via the scope menu.
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={vi.fn()} />)
    })
    expect(container.textContent).toContain('this conversation')
    expect(container.textContent).not.toContain('this call only')
  })

  it('uses option scope metadata and labels session access accurately', () => {
    const scopedRequest: AcpPermissionRequest = {
      ...baseRequest,
      options: [
        { optionId: 'scoped-once', name: 'One request', kind: 'custom', scope: 'once' },
        { optionId: 'scoped-session', name: 'Standing access', kind: 'custom', scope: 'session' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' }
      ]
    }

    act(() => {
      root.render(<PermissionApprovalControls requests={[scopedRequest]} onRespond={vi.fn()} />)
    })

    expect(
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).textContent
    ).toBe('Allow for this conversation')

    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement
    act(() => chevron.click())

    const sessionItem = Array.from(container.querySelectorAll('[role="menuitemradio"]')).find(
      (item) => item.textContent?.includes('This conversation')
    )
    expect(sessionItem?.textContent).toContain('Remembered for this conversation')
    expect(container.textContent).not.toContain('Agent session')
  })

  it('Allow with default scope calls onRespond with the allow_always optionId', () => {
    const onRespond = vi.fn()
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={onRespond} />)
    })
    const allowBtn = container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement
    act(() => allowBtn.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-always')
  })

  it('locks every response control after the first submission and ignores a repeated click', () => {
    const onRespond = vi.fn(() => new Promise<void>(() => undefined))
    const requestWithExtra: AcpPermissionRequest = {
      ...baseRequest,
      options: [
        ...baseRequest.options,
        { optionId: 'opt-sandbox', name: 'Run in sandbox', kind: 'allow_sandbox' }
      ]
    }

    act(() => {
      root.render(
        <PermissionApprovalControls requests={[requestWithExtra]} onRespond={onRespond} />
      )
    })

    const allowButton = container.querySelector(
      '[data-testid="allow-primary"]'
    ) as HTMLButtonElement
    act(() => {
      allowButton.click()
      allowButton.click()
    })

    expect(onRespond).toHaveBeenCalledTimes(1)
    for (const testId of ['allow-primary', 'deny-button', 'extra-option', 'scope-chevron']) {
      expect(
        (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).disabled
      ).toBe(true)
    }
  })

  it('unlocks response controls when submitting the response fails', async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error('response failed'))

    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={onRespond} />)
    })

    const allowButton = container.querySelector(
      '[data-testid="allow-primary"]'
    ) as HTMLButtonElement
    await act(async () => allowButton.click())

    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(allowButton.disabled).toBe(false)
  })

  it('unlocks response controls when the displayed request changes', () => {
    const onRespond = vi.fn()
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={onRespond} />)
    })

    const firstAllow = container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement
    act(() => firstAllow.click())
    expect(firstAllow.disabled).toBe(true)

    const nextRequest: AcpPermissionRequest = {
      ...baseRequest,
      requestId: 'req-2',
      toolCallId: 'tool-2'
    }
    act(() => {
      root.render(<PermissionApprovalControls requests={[nextRequest]} onRespond={onRespond} />)
    })

    const nextAllow = container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement
    expect(nextAllow.disabled).toBe(false)
    act(() => nextAllow.click())
    expect(onRespond).toHaveBeenNthCalledWith(2, 'req-2', 'opt-always')
  })

  it('switching to Once updates button label and calls allow_once optionId', () => {
    const onRespond = vi.fn()
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={onRespond} />)
    })
    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement
    act(() => chevron.click())
    const onceItem = Array.from(container.querySelectorAll('[role="menuitemradio"]')).find(
      (el) => el.textContent?.includes('Once') && !el.textContent?.includes('session')
    ) as HTMLElement
    act(() => onceItem.click())
    expect(container.textContent).toContain('Allow once')
    const allowBtn = container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement
    act(() => allowBtn.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-once')
  })

  it('selecting This conversation sends the session option from the primary button', () => {
    const onRespond = vi.fn()
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={onRespond} />)
    })

    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement
    act(() => chevron.click())
    const sessionItem = Array.from(
      container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent?.includes('This conversation'))

    expect(sessionItem).toBeDefined()
    act(() => sessionItem?.click())

    const allowButton = container.querySelector(
      '[data-testid="allow-primary"]'
    ) as HTMLButtonElement
    expect(allowButton.textContent).toBe('Allow for this conversation')
    act(() => allowButton.click())

    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-always')
  })

  it('confirms Project and Global Broker scopes before sending their exact option ids', async () => {
    const onRespond = vi.fn()
    const scopedRequest: AcpPermissionRequest = {
      ...baseRequest,
      commandPrefix: ['python', 'analyze.py'],
      options: [
        { optionId: 'scope-once', name: 'Once', kind: 'allow_once', scope: 'once' },
        {
          optionId: 'scope-session',
          name: 'This session',
          kind: 'allow_always',
          scope: 'session'
        },
        {
          optionId: 'scope-project',
          name: 'This project',
          kind: 'allow_always',
          scope: 'project'
        },
        {
          optionId: 'scope-global',
          name: 'Global',
          kind: 'allow_always',
          scope: 'global'
        },
        { optionId: 'scope-deny', name: 'Deny', kind: 'reject_once' }
      ]
    }

    act(() => {
      root.render(<PermissionApprovalControls requests={[scopedRequest]} onRespond={onRespond} />)
    })
    act(() =>
      (container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement).click()
    )
    const project = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent?.includes('This project'))
    expect(project).toBeDefined()
    act(() => project?.click())
    expect(container.querySelector('[data-testid="allow-primary"]')?.textContent).toBe(
      'Allow for this project'
    )
    act(() =>
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).click()
    )
    expect(onRespond).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Allow this command group for this project?')
    expect(document.body.textContent).toContain(
      'Code will run without preview for every session in this project.'
    )
    expect(document.body.textContent).toContain('Settings → Permissions')
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.className).toContain('w-[min(420px,calc(100vw-2rem))]')
    expect(dialog?.className).toContain('p-0')
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-b border-border-300/90')
      )
    ).toBe(true)
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-t border-border-300/90')
      )
    ).toBe(true)
    expect(dialog?.querySelector('h2')?.className).toContain('text-lg')
    expect(dialog?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')).not.toBeNull()

    const cancel = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="permission-scope-cancel"]'
    )
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="permission-scope-confirm"]'
    )
    expect(cancel?.className).toContain('h-8')
    expect(confirm?.className).toContain('h-8')
    expect(cancel?.className).not.toContain('min-h-11')
    expect(confirm?.className).not.toContain('min-h-11')
    expect(document.activeElement).toBe(cancel)

    act(() => cancel?.click())
    await act(async () => Promise.resolve())
    expect(onRespond).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="permission-scope-confirmation"]')).toBeNull()
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('[data-testid="allow-primary"]')
    )

    act(() =>
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).click()
    )
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="permission-scope-confirm"]')
        ?.click()
    )
    expect(onRespond).toHaveBeenCalledWith('req-1', 'scope-project')

    act(() => {
      root.render(
        <PermissionApprovalControls
          requests={[{ ...scopedRequest, requestId: 'req-2', toolCallId: 'tool-2' }]}
          onRespond={onRespond}
        />
      )
    })
    act(() =>
      (container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement).click()
    )
    const global = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent?.includes('Global'))
    expect(global).toBeDefined()
    act(() => global?.click())
    expect(container.querySelector('[data-testid="allow-primary"]')?.textContent).toBe(
      'Allow globally'
    )
    act(() =>
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).click()
    )
    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Allow this command group globally?')
    expect(document.body.textContent).toContain(
      'Code will run without preview for every session in every project.'
    )
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => Promise.resolve())
    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('[data-testid="allow-primary"]')
    )

    act(() =>
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).click()
    )
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="permission-scope-confirm"]')
        ?.click()
    )
    expect(onRespond).toHaveBeenCalledWith('req-2', 'scope-global')
    expect(onRespond).toHaveBeenCalledTimes(2)
  })

  it('names the R runtime in the broad-scope warning without exposing the MCP tool name', () => {
    const onRespond = vi.fn()
    const rRequest: AcpPermissionRequest = {
      ...baseRequest,
      title: 'mcp__open-science-notebook__notebook_execute',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      rawInput: { code: 'df <- read.csv("samples.csv")' },
      options: [
        { optionId: 'scope-once', name: 'Once', kind: 'allow_once', scope: 'once' },
        {
          optionId: 'scope-project',
          name: 'This project',
          kind: 'allow_always',
          scope: 'project'
        },
        { optionId: 'scope-deny', name: 'Deny', kind: 'reject_once' }
      ]
    }

    act(() => {
      root.render(<PermissionApprovalControls requests={[rRequest]} onRespond={onRespond} />)
    })
    act(() =>
      (container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement).click()
    )
    const project = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent?.includes('This project'))
    act(() => project?.click())
    act(() =>
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).click()
    )

    expect(document.body.textContent).toContain('Allow r for this project?')
    expect(document.body.textContent).not.toContain('mcp__open-science-notebook')
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('uses a stable Broker MCP identity without falling back to the ACP provider name', () => {
    const request: AcpPermissionRequest = {
      ...baseRequest,
      title: 'mcp__provider_specific_chem__search_articles',
      providerToolName: 'mcp__provider_specific_chem__search_articles',
      isMcp: true,
      mcpIdentity: 'chem-search/search_articles',
      options: [
        { optionId: 'scope-once', name: 'Once', kind: 'allow_once', scope: 'once' },
        {
          optionId: 'scope-project',
          name: 'This project',
          kind: 'allow_always',
          scope: 'project'
        },
        { optionId: 'scope-deny', name: 'Deny', kind: 'reject_once' }
      ]
    }

    act(() => root.render(<PermissionApprovalControls requests={[request]} onRespond={vi.fn()} />))
    act(() =>
      (container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement).click()
    )
    const project = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent?.includes('This project'))
    act(() => project?.click())
    act(() =>
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).click()
    )

    expect(document.body.textContent).toContain(
      'Allow Chem Search / Search Articles for this project?'
    )
    expect(document.body.textContent).not.toContain('provider_specific_chem')
  })

  it('uses generic confirmation copy when an MCP request lacks a stable Broker identity', () => {
    const request: AcpPermissionRequest = {
      ...baseRequest,
      title: 'mcp__untrusted_provider__dangerous_tool',
      providerToolName: 'mcp__untrusted_provider__dangerous_tool',
      isMcp: true,
      mcpIdentity: undefined,
      options: [
        { optionId: 'scope-once', name: 'Once', kind: 'allow_once', scope: 'once' },
        {
          optionId: 'scope-project',
          name: 'This project',
          kind: 'allow_always',
          scope: 'project'
        },
        { optionId: 'scope-deny', name: 'Deny', kind: 'reject_once' }
      ]
    }

    act(() => root.render(<PermissionApprovalControls requests={[request]} onRespond={vi.fn()} />))
    act(() =>
      (container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement).click()
    )
    const project = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ).find((item) => item.textContent?.includes('This project'))
    act(() => project?.click())
    act(() =>
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).click()
    )

    const confirmation = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(confirmation?.textContent).toContain('Allow this external service for this project?')
    expect(confirmation?.textContent).not.toContain('untrusted_provider')
    expect(confirmation?.textContent).not.toContain('Untrusted Provider')
  })

  it('uses the only available scope without rendering a redundant picker', () => {
    const onRespond = vi.fn()
    // Only a session-scope option exists; "once" must not borrow it.
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
    // Defaults to the available session scope.
    expect(container.textContent).toContain('Allow for this conversation')
    expect(container.querySelector('[data-testid="scope-chevron"]')).toBeNull()
    expect(container.querySelector('[role="menu"]')).toBeNull()
    // Allowing sends the session option, never a mislabeled once grant.
    const allowBtn = container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement
    act(() => allowBtn.click())
    expect(onRespond).toHaveBeenCalledWith('req-1', 'opt-always')
  })

  it('renders no scope picker when the request has no allow scope', () => {
    const noAllowScope: AcpPermissionRequest = {
      ...baseRequest,
      options: [
        { optionId: 'opt-sandbox', name: 'Run in sandbox', kind: 'allow_sandbox' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' }
      ]
    }

    act(() => {
      root.render(<PermissionApprovalControls requests={[noAllowScope]} onRespond={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="scope-chevron"]')).toBeNull()
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(
      (container.querySelector('[data-testid="allow-primary"]') as HTMLButtonElement).disabled
    ).toBe(true)
    expect(container.querySelector('[data-testid="extra-option"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="deny-button"]')).not.toBeNull()
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

  it('requires confirmation for a broad-scope extra option', () => {
    const onRespond = vi.fn()
    const withDuplicateProjectScope: AcpPermissionRequest = {
      ...baseRequest,
      options: [
        { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
        { optionId: 'project-primary', name: 'Project', kind: 'custom', scope: 'project' },
        { optionId: 'project-extra', name: 'Project fallback', kind: 'custom', scope: 'project' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' }
      ]
    }
    act(() => {
      root.render(
        <PermissionApprovalControls requests={[withDuplicateProjectScope]} onRespond={onRespond} />
      )
    })

    const extra = container.querySelector('[data-testid="extra-option"]') as HTMLButtonElement
    act(() => extra.click())

    expect(onRespond).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Allow this command for this project?')

    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="permission-scope-confirm"]')
        ?.click()
    )
    expect(onRespond).toHaveBeenCalledWith('req-1', 'project-extra')
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
    // The menu opens with focus on the currently selected Session scope.
    expect(document.activeElement).toBe(items[1])

    // ArrowDown wraps from the last item back to the first.
    act(() => {
      items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(items[0])

    act(() => {
      items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(container.textContent).toContain('Allow once')
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

  it('does not reset keyboard focus when the parent rerenders the same request', async () => {
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={vi.fn()} />)
    })
    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement

    await act(async () => chevron.click())
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    )
    act(() => {
      items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(items[1])

    act(() => {
      root.render(
        <PermissionApprovalControls requests={[{ ...baseRequest }]} onRespond={vi.fn()} />
      )
    })

    expect(document.activeElement).toBe(items[1])
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
    // Switch req-1 to Once (away from the default Conversation) and leave the menu open, then swap
    // to a fresh request to verify all state resets.
    act(() => {
      root.render(<PermissionApprovalControls requests={[baseRequest]} onRespond={vi.fn()} />)
    })
    const chevron = container.querySelector('[data-testid="scope-chevron"]') as HTMLButtonElement
    act(() => chevron.click())
    const onceItem = Array.from(container.querySelectorAll('[role="menuitemradio"]')).find(
      (el) => el.textContent?.includes('Once') && !el.textContent?.includes('session')
    ) as HTMLElement
    act(() => onceItem.click())
    // Collapse the code card so we can prove it re-expands for the next request.
    const toggle = container.querySelector(
      '[data-testid="permission-code-toggle"]'
    ) as HTMLButtonElement
    act(() => toggle.click())
    expect(container.textContent).toContain('Allow once')
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
    // Scope reset to the default Session, menu closed, card re-expanded.
    expect(container.textContent).toContain('this conversation')
    expect(container.textContent).not.toContain('this call only')
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

  it('falls back to the Settings runtime name for the env badge before any kernel ran', async () => {
    // No live kernel and no run history: the badge must still name the enabled runtime from
    // Settings → Runtimes (the app-managed default wins over user-registered envs).
    const notebookRequest: AcpPermissionRequest = {
      requestId: 'req-env',
      sessionId: 'session-env-fallback',
      toolCallId: 'tool-env',
      title: 'mcp__open-science-notebook__notebook_execute',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      rawInput: { kernelKind: 'python', code: 'print(1)' },
      options: [{ optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' }]
    }
    ;(window as { api?: unknown }).api = {
      notebook: {
        state: async () => ({ environments: [], runs: [] })
      },
      runtime: {
        listEnvironments: async () => ({
          python: [
            {
              language: 'python',
              provenance: 'app-managed',
              envId: '/envs/default-python',
              interpreterPath: '/envs/default-python/bin/python',
              label: 'default-python',
              runnable: true
            }
          ],
          r: []
        }),
        getEnablement: async () => ({ enabled: {}, installAuthorized: {} })
      }
    }
    try {
      act(() => {
        root.render(
          <PermissionApprovalControls
            requests={[notebookRequest]}
            onRespond={vi.fn()}
            notebookLookup={{ sessionId: 'session-env-fallback', workspaceCwd: '' }}
          />
        )
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.querySelector('[data-testid="permission-env-badge"]')?.textContent).toBe(
        'default-python'
      )
      expect(
        container.querySelector('[data-testid="permission-category-badge"]')?.textContent
      ).toBe('Python execution')
    } finally {
      delete (window as { api?: unknown }).api
    }
  })

  it('uses the latest durable environment when it is outside the bounded run window', async () => {
    const notebookRequest: AcpPermissionRequest = {
      requestId: 'req-historical-env',
      sessionId: 'session-historical-env',
      toolCallId: 'tool-historical-env',
      title: 'mcp__open-science-notebook__notebook_execute',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      rawInput: { kernelKind: 'python', code: 'print(1)' },
      options: [{ optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' }]
    }
    ;(window as { api?: unknown }).api = {
      notebook: {
        state: async () => ({
          environments: [],
          latestRunEnvironments: { python: 'historical-python' },
          runs: []
        })
      },
      runtime: {
        listEnvironments: async () => ({
          python: [
            {
              language: 'python',
              provenance: 'app-managed',
              envId: '/envs/default-python',
              interpreterPath: '/envs/default-python/bin/python',
              label: 'default-python',
              runnable: true
            }
          ],
          r: []
        }),
        getEnablement: async () => ({ enabled: {}, installAuthorized: {} })
      }
    }
    try {
      act(() => {
        root.render(
          <PermissionApprovalControls
            requests={[notebookRequest]}
            onRespond={vi.fn()}
            notebookLookup={{ sessionId: 'session-historical-env', workspaceCwd: '' }}
          />
        )
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.querySelector('[data-testid="permission-env-badge"]')?.textContent).toBe(
        'historical-python'
      )
    } finally {
      delete (window as { api?: unknown }).api
    }
  })

  it('refreshes the environment badge for a later permission in the same session', async () => {
    const firstRequest: AcpPermissionRequest = {
      requestId: 'req-refresh-env-1',
      sessionId: 'session-refresh-env',
      toolCallId: 'tool-refresh-env-1',
      title: 'mcp__open-science-notebook__notebook_execute',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      rawInput: { kernelKind: 'python', code: 'print(1)' },
      options: [{ optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' }]
    }
    let environment = 'first-python'
    ;(window as { api?: unknown }).api = {
      notebook: {
        state: async () => ({
          environments: [{ kind: 'python', environment, processKey: `python:${environment}` }],
          runs: []
        })
      }
    }
    try {
      act(() => {
        root.render(
          <PermissionApprovalControls
            requests={[firstRequest]}
            onRespond={vi.fn()}
            notebookLookup={{ sessionId: 'session-refresh-env', workspaceCwd: '' }}
          />
        )
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.querySelector('[data-testid="permission-env-badge"]')?.textContent).toBe(
        'first-python'
      )

      environment = 'second-python'
      act(() => {
        root.render(
          <PermissionApprovalControls
            requests={[
              {
                ...firstRequest,
                requestId: 'req-refresh-env-2',
                toolCallId: 'tool-refresh-env-2'
              }
            ]}
            onRespond={vi.fn()}
            notebookLookup={{ sessionId: 'session-refresh-env', workspaceCwd: '' }}
          />
        )
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(container.querySelector('[data-testid="permission-env-badge"]')?.textContent).toBe(
        'second-python'
      )
    } finally {
      delete (window as { api?: unknown }).api
    }
  })

  it('does not use a live Python environment for an R permission request', async () => {
    const rNotebookRequest: AcpPermissionRequest = {
      requestId: 'req-r-env',
      sessionId: 'session-r-env',
      toolCallId: 'tool-r-env',
      title: 'mcp__open-science-notebook__notebook_execute',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      rawInput: { kernelKind: 'r', code: 'x <- 1' },
      options: [{ optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' }]
    }
    ;(window as { api?: unknown }).api = {
      notebook: {
        state: async () => ({
          environments: [
            { kind: 'python', environment: 'default-python', processKey: 'python:default-python' }
          ],
          runs: []
        })
      },
      runtime: {
        listEnvironments: async () => ({
          python: [],
          r: [
            {
              language: 'r',
              provenance: 'app-managed',
              envId: '/envs/default-r',
              interpreterPath: '/envs/default-r/bin/R',
              label: 'default-r',
              runnable: true
            }
          ]
        }),
        getEnablement: async () => ({ enabled: {}, installAuthorized: {} })
      }
    }
    try {
      act(() => {
        root.render(
          <PermissionApprovalControls
            requests={[rNotebookRequest]}
            onRespond={vi.fn()}
            notebookLookup={{ sessionId: 'session-r-env', workspaceCwd: '' }}
          />
        )
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.querySelector('[data-testid="permission-env-badge"]')?.textContent).toBe(
        'default-r'
      )
      expect(
        container.querySelector('[data-testid="permission-category-badge"]')?.textContent
      ).toBe('R execution')
    } finally {
      delete (window as { api?: unknown }).api
    }
  })

  it('does not retain a Python environment badge while switching to an R request', async () => {
    const pythonRequest: AcpPermissionRequest = {
      requestId: 'req-transition-python',
      sessionId: 'session-runtime-transition',
      toolCallId: 'tool-transition-python',
      title: 'mcp__open-science-notebook__notebook_execute',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      rawInput: { kernelKind: 'python', code: 'x = 1' },
      options: [{ optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const rRequest: AcpPermissionRequest = {
      ...pythonRequest,
      requestId: 'req-transition-r',
      toolCallId: 'tool-transition-r',
      rawInput: { kernelKind: 'r', code: 'x <- 1' }
    }
    ;(window as { api?: unknown }).api = {
      notebook: { state: async () => ({ environments: [], runs: [] }) },
      runtime: {
        listEnvironments: async () => ({
          python: [
            {
              language: 'python',
              provenance: 'app-managed',
              envId: '/envs/default-python',
              interpreterPath: '/envs/default-python/bin/python',
              label: 'default-python',
              runnable: true
            }
          ],
          r: [
            {
              language: 'r',
              provenance: 'app-managed',
              envId: '/envs/default-r',
              interpreterPath: '/envs/default-r/bin/R',
              label: 'default-r',
              runnable: true
            }
          ]
        }),
        getEnablement: async () => ({ enabled: {}, installAuthorized: {} })
      }
    }
    try {
      act(() => {
        root.render(
          <PermissionApprovalControls
            requests={[pythonRequest]}
            onRespond={vi.fn()}
            notebookLookup={{ sessionId: 'session-runtime-transition', workspaceCwd: '' }}
          />
        )
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.querySelector('[data-testid="permission-env-badge"]')?.textContent).toBe(
        'default-python'
      )

      act(() => {
        root.render(
          <PermissionApprovalControls
            requests={[rRequest]}
            onRespond={vi.fn()}
            notebookLookup={{ sessionId: 'session-runtime-transition', workspaceCwd: '' }}
          />
        )
      })
      expect(container.querySelector('[data-testid="permission-env-badge"]')).toBeNull()

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.querySelector('[data-testid="permission-env-badge"]')?.textContent).toBe(
        'default-r'
      )
    } finally {
      delete (window as { api?: unknown }).api
    }
  })
})
