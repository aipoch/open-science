// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerAgentControlsMenu } from './ComposerAgentControlsMenu'

import type { ComputeHost } from '../../../../shared/compute'
import { i18next } from '@/i18n'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Select events fired through the mocked menu items, so tests can assert preventDefault
// (i.e. the row keeps the real menu open instead of closing it).
const { mediaState, selectEvents } = vi.hoisted(() => ({
  mediaState: { mobile: false },
  selectEvents: [] as Array<{ preventDefault: () => void; prevented: boolean }>
}))

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: (): boolean => mediaState.mobile
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children, open }: PropsWithChildren<{ open?: boolean }>): React.JSX.Element => (
    <div data-testid="agent-controls-menu" data-open={String(open ?? false)}>
      {children}
    </div>
  ),
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  DropdownMenuSeparator: (): React.JSX.Element => <hr />,
  DropdownMenuLabel: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dropdown-label">{children}</div>
  ),
  DropdownMenuGroup: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dropdown-group">{children}</div>
  ),
  DropdownMenuSub: ({
    children,
    open
  }: PropsWithChildren<{ open?: boolean }>): React.JSX.Element => (
    <div data-testid="dropdown-sub" data-open={String(open ?? false)}>
      {children}
    </div>
  ),
  // testids let tests tell a hover submenu trigger/content apart from an inline label/group,
  // so a regression that flattens a submenu into the primary panel is caught.
  DropdownMenuSubTrigger: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="submenu-trigger">{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="submenu-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: PropsWithChildren<{
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
    [key: string]: unknown
  }>): React.JSX.Element => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        const event = {
          prevented: false,
          preventDefault(): void {
            event.prevented = true
          }
        }
        selectEvents.push(event)
        onSelect?.(event)
      }}
      {...rest}
    >
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked }: { checked?: boolean }): React.JSX.Element => (
    <span data-testid="auto-review-switch" data-checked={String(checked)} />
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  Tooltip: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  TooltipContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <span data-testid="tooltip-content">{children}</span>
  )
}))

vi.mock('radix-ui', () => ({
  AlertDialog: {
    Root: ({ open, children }: PropsWithChildren<{ open?: boolean }>): React.JSX.Element | null =>
      open ? <div>{children}</div> : null,
    Portal: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
    Overlay: ({ className }: { className?: string }): React.JSX.Element => (
      <div data-testid="full-access-overlay" className={className} />
    ),
    Content: ({
      children,
      className
    }: PropsWithChildren<{ className?: string }>): React.JSX.Element => (
      <div data-testid="full-access-dialog" className={className}>
        {children}
      </div>
    ),
    Title: ({
      children,
      className
    }: PropsWithChildren<{ className?: string }>): React.JSX.Element => (
      <h2 className={className}>{children}</h2>
    ),
    Description: ({
      children,
      className
    }: PropsWithChildren<{ className?: string }>): React.JSX.Element => (
      <p className={className}>{children}</p>
    ),
    Cancel: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
    Action: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>
  }
}))

// Stub the specialist submenu so its store/catalog wiring stays out of this menu-level suite.
// The marker surfaces whether the menu included it and forwards key props as data attributes.
vi.mock('./SpecialistSubmenu', () => ({
  SpecialistSubmenu: (props: {
    selectedId?: string
    unavailable?: boolean
    readOnly?: boolean
  }): React.JSX.Element => (
    <div
      data-testid="specialist-submenu-stub"
      data-selected-id={props.selectedId ?? ''}
      data-unavailable={String(props.unavailable ?? false)}
      data-read-only={String(props.readOnly ?? false)}
    />
  )
}))

const createHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:cluster-1',
  displayName: 'cluster-1',
  shape: 'direct_ssh',
  sshAlias: 'cluster-1',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mediaState.mobile = false
  selectEvents.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  // Prime the compute store with two SSH hosts so the merged compute section renders them;
  // settings store gets a spy for the Manage compute navigation.
  useComputeStore.setState({
    ...createInitialComputeState(),
    hosts: [
      createHost({ providerId: 'ssh:cluster-1', displayName: 'cluster-1', sshAlias: 'cluster-1' }),
      createHost({
        id: 'host-2',
        providerId: 'ssh:gpu-box',
        displayName: 'gpu-box',
        sshAlias: 'gpu-box'
      })
    ],
    isLoaded: true
  })
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    openSettingsToCompute: vi.fn() as () => void
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const findButton = (label: string): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )

  if (!button) throw new Error(`button not found: ${label}`)

  return button
}

const expectStandingDisabled = (button: HTMLButtonElement, disabled: boolean): void => {
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe(String(disabled))
}

describe('ComposerAgentControlsMenu', () => {
  it('opens when the composer requests Specialist selection', () => {
    const props = {
      profile: 'ask' as const,
      autoReviewEnabled: false,
      onProfileChange: vi.fn(),
      onAutoReviewChange: vi.fn()
    }

    act(() => {
      root.render(<ComposerAgentControlsMenu {...props} openRequest={0} />)
    })
    expect(
      container.querySelector('[data-testid="agent-controls-menu"]')?.getAttribute('data-open')
    ).toBe('false')

    act(() => {
      root.render(<ComposerAgentControlsMenu {...props} openRequest={1} />)
    })
    expect(
      container.querySelector('[data-testid="agent-controls-menu"]')?.getAttribute('data-open')
    ).toBe('true')
  })

  it('opens the root menu and Compute submenu when the execution-target indicator requests it', () => {
    const props = {
      profile: 'ask' as const,
      autoReviewEnabled: false,
      enabledComputeHosts: ['ssh:cluster-1'],
      onProfileChange: vi.fn(),
      onAutoReviewChange: vi.fn(),
      onComputeHostEnabledChange: vi.fn(),
      onComputeHostSelectedChange: vi.fn()
    }

    act(() => {
      root.render(<ComposerAgentControlsMenu {...props} computeOpenRequest={0} />)
    })

    act(() => {
      root.render(<ComposerAgentControlsMenu {...props} computeOpenRequest={1} />)
    })

    expect(
      container.querySelector('[data-testid="agent-controls-menu"]')?.getAttribute('data-open')
    ).toBe('true')
    const computeSubmenu = Array.from(
      container.querySelectorAll('[data-testid="dropdown-sub"]')
    ).find((candidate) => candidate.textContent?.includes('cluster-1'))
    expect(computeSubmenu?.getAttribute('data-open')).toBe('true')
  })

  it('changes Ask and Auto directly without a risk dialog', () => {
    const onProfileChange = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          onProfileChange={onProfileChange}
          onAutoReviewChange={vi.fn()}
        />
      )
    })
    const trigger = container.querySelector('[data-testid="composer-controls-trigger"]')
    expect(trigger?.getAttribute('aria-label')).toBe(
      'Agent controls: Ask for approval, auto-review Off, Delegation On'
    )
    act(() => findButton('Auto-approve edits').click())

    expect(onProfileChange).toHaveBeenCalledWith('auto')
    expect(container.textContent).not.toContain('Enable Full access?')
  })

  it('localizes auto-review and Delegation states in the trigger accessible label', async () => {
    await act(() => i18next.changeLanguage('ja'))
    try {
      act(() => {
        root.render(
          <ComposerAgentControlsMenu
            profile="ask"
            autoReviewEnabled={false}
            onProfileChange={vi.fn()}
            onAutoReviewChange={vi.fn()}
          />
        )
      })

      expect(
        container
          .querySelector('[data-testid="composer-controls-trigger"]')
          ?.getAttribute('aria-label')
      ).toBe('エージェントコントロール：承認を求める、自動レビュー オフ、委任 オン')
    } finally {
      await act(() => i18next.changeLanguage('en'))
    }
  })

  it('toggles Memory for the conversation without closing the menu', () => {
    const onMemoryChange = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          memoryEnabled
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onMemoryChange={onMemoryChange}
        />
      )
    })

    act(() => findButton('Memory').click())

    expect(onMemoryChange).toHaveBeenCalledWith(false)
    expect(selectEvents.at(-1)?.prevented).toBe(true)
  })

  it('shows Delegation after Memory, exposes the saved state, and treats Off as non-default', () => {
    const onDelegationChange = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          memoryEnabled
          delegationEnabled={false}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onDelegationChange={onDelegationChange}
        />
      )
    })

    const row = findButton('Delegation')
    expectStandingDisabled(row, false)
    expect(container.textContent).toContain(
      'Block new Subagents. Existing Subagents are unaffected.'
    )
    expect(container.querySelector('[data-testid="controls-nondefault-dot"]')).not.toBeNull()
    expect(
      container
        .querySelector('[data-testid="composer-controls-trigger"]')
        ?.getAttribute('aria-label')
    ).toBe('Agent controls: Ask for approval, auto-review Off, Delegation Off')
    expect(container.textContent!.indexOf('Memory')).toBeLessThan(
      container.textContent!.indexOf('Delegation')
    )
    expect(container.textContent!.indexOf('Delegation')).toBeLessThan(
      container.textContent!.indexOf('Compute')
    )

    act(() => row.click())

    expect(onDelegationChange).toHaveBeenCalledWith(true)
    expect(selectEvents.at(-1)?.prevented).toBe(true)
  })

  it('disables Delegation while its authoritative mutation is pending', () => {
    const onDelegationChange = vi.fn()
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          delegationEnabled
          delegationPending
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onDelegationChange={onDelegationChange}
        />
      )
    })

    const row = findButton('Delegation')
    expect(row.disabled).toBe(true)
    expect(row.hasAttribute('aria-disabled')).toBe(false)
    expect(container.textContent).not.toContain('Allow the Main Agent to create new Subagents.')
    act(() => row.click())
    expect(onDelegationChange).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'keeps Delegation independently editable while the rest of Agent controls are read-only (mobile=%s)',
    (mobile) => {
      mediaState.mobile = mobile
      const onDelegationChange = vi.fn()
      act(() => {
        root.render(
          <ComposerAgentControlsMenu
            profile="ask"
            autoReviewEnabled={false}
            delegationEnabled
            readOnly
            delegationReadOnly={false}
            delegationHasLiveAttempts
            onProfileChange={vi.fn()}
            onAutoReviewChange={vi.fn()}
            onDelegationChange={onDelegationChange}
          />
        )
      })

      const row = findButton('Delegation')
      expectStandingDisabled(row, false)
      expect(container.textContent).toContain(
        'Turning Delegation off only blocks new Subagents. Existing Subagents continue running and remain available.'
      )
      act(() => row.click())
      expect(onDelegationChange).toHaveBeenCalledWith(false)
    }
  )

  it('shows the saved value and framework reason without mutating when unavailable', () => {
    const onDelegationChange = vi.fn()
    const reason = 'The selected agent framework does not support delegated work.'
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          delegationEnabled={false}
          delegationReadOnly
          delegationDisabledReason={reason}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onDelegationChange={onDelegationChange}
        />
      )
    })

    const row = findButton('Delegation')
    expectStandingDisabled(row, true)
    expect(container.textContent).toContain(reason)
    expect(
      container
        .querySelector('[data-testid="composer-controls-trigger"]')
        ?.getAttribute('aria-label')
    ).toContain('Delegation Off')
    act(() => row.click())
    expect(onDelegationChange).not.toHaveBeenCalled()
  })

  it('shows why Memory is unavailable when the global setting is off', () => {
    const onMemoryChange = vi.fn()
    const reason = 'Memory is off in Settings. Turn it on to use Memory in this conversation.'

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          memoryEnabled={false}
          memoryReadOnly
          memoryDisabledReason={reason}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onMemoryChange={onMemoryChange}
        />
      )
    })

    const memoryRow = findButton('Memory')
    expectStandingDisabled(memoryRow, true)
    expect(container.querySelector('[data-testid="controls-nondefault-dot"]')).toBeNull()
    act(() => memoryRow.click())
    expect(onMemoryChange).not.toHaveBeenCalled()
  })

  it('keeps menu descriptions out of the compact rows', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          memoryEnabled
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    expect(findButton('Ask for approval').textContent).toBe('Ask for approval')
    expect(findButton('Auto-review').textContent).toBe('Auto-review')
    expect(findButton('Memory').textContent).toBe('Memory')
    expect(findButton('Delegation').textContent).toBe('Delegation')
  })

  it('opens permission choices inside the same menu on mobile and can return', () => {
    mediaState.mobile = true

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    expect(container.textContent).not.toContain('Auto-approve edits')

    const permissionTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-permission-trigger"]'
    )
    if (!permissionTrigger) throw new Error('mobile permission trigger not found')
    act(() => permissionTrigger.click())

    expect(container.textContent).toContain('Auto-approve edits')
    expect(container.textContent).not.toContain('Auto-review')
    expect(selectEvents.at(-1)?.prevented).toBe(true)

    const backButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-permission-back"]'
    )
    if (!backButton) throw new Error('mobile permission back button not found')
    act(() => backButton.click())

    expect(container.textContent).toContain('Auto-review')
    expect(container.textContent).not.toContain('Auto-approve edits')
  })

  it('requires explicit confirmation before enabling Full access', () => {
    const onProfileChange = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          onProfileChange={onProfileChange}
          onAutoReviewChange={vi.fn()}
        />
      )
    })
    act(() => findButton('Full access').click())

    expect(onProfileChange).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Enable Full access?')
    expect(findButton('Cancel').getAttribute('data-slot')).toBe('button')
    expect(findButton('Cancel').getAttribute('data-variant')).toBe('ghost')
    expect(findButton('Cancel').className).toContain('border-0')
    expect(findButton('Cancel').className).toContain('shadow-none')
    const confirmButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) =>
        candidate.textContent?.trim() === 'Enable' &&
        candidate.getAttribute('data-slot') === 'button'
    )
    expect(confirmButton?.getAttribute('data-slot')).toBe('button')
    expect(confirmButton?.className).toContain('bg-amber-600')

    const overlay = container.querySelector<HTMLElement>('[data-testid="full-access-overlay"]')
    const dialog = container.querySelector<HTMLElement>('[data-testid="full-access-dialog"]')

    expect(overlay?.className).toContain('bg-black/50')
    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(overlay?.className).not.toContain('backdrop-blur')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('p-0')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.querySelector('[aria-label="Close"]')).not.toBeNull()
    const title = dialog?.querySelector('h2')
    const description = dialog?.querySelector('p')
    expect(title?.parentElement?.parentElement?.className).toContain('border-b')
    expect(title?.parentElement?.parentElement?.contains(description ?? null)).toBe(false)
    expect(description?.parentElement?.className).toContain('p-5')

    act(() => confirmButton?.click())
    expect(onProfileChange).toHaveBeenCalledWith('full')
  })

  it('disables Full access when the attached Agent does not advertise bypass mode', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          profileState={{
            selectedProfile: 'ask',
            effectiveProfile: 'ask',
            currentModeId: 'default',
            availableModeIds: ['default'],
            fullAccessAvailable: false
          }}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    expectStandingDisabled(findButton('Full access'), true)
  })

  it('lists session grants and revokes the clicked one', () => {
    const onRevokeGrant = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          grants={[
            { categoryKey: 'shell:git', label: 'git status', kind: 'shell', scope: 'session' },
            { categoryKey: 'mcp:search', label: 'search papers', kind: 'mcp', scope: 'session' }
          ]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onRevokeGrant={onRevokeGrant}
        />
      )
    })

    expect(container.textContent).toContain('Allowed this session')
    expect(container.textContent).toContain('git status')

    const revokeButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Revoke session grant for git status'
    )

    if (!revokeButton) throw new Error('revoke button not found')

    act(() => revokeButton.click())

    expect(onRevokeGrant).toHaveBeenCalledWith('shell:git')
  })

  it.each(['auto', 'full'] as const)(
    'keeps Ask conversation grants visible while the %s profile is selected',
    (profile) => {
      act(() => {
        root.render(
          <ComposerAgentControlsMenu
            profile={profile}
            autoReviewEnabled={false}
            grants={[
              {
                categoryKey: 'mcp:notebook/python',
                label: 'Notebook REPL (Python)',
                kind: 'mcp',
                scope: 'session'
              }
            ]}
            onProfileChange={vi.fn()}
            onAutoReviewChange={vi.fn()}
          />
        )
      })

      expect(container.textContent).toContain('Allowed this session')
      expect(container.textContent).toContain('Notebook REPL (Python)')
    }
  )

  it('clears all grants when Clear all is clicked', () => {
    const onClearGrants = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          grants={[
            { categoryKey: 'shell:git', label: 'git status', kind: 'shell', scope: 'session' },
            { categoryKey: 'tool:Write', label: 'Write', kind: 'tool', scope: 'session' }
          ]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onClearGrants={onClearGrants}
        />
      )
    })

    const clearButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Clear all session grants'
    )

    if (!clearButton) throw new Error('clear button not found')

    act(() => clearButton.click())

    expect(onClearGrants).toHaveBeenCalledTimes(1)
  })

  it('shows the current level as a short label in the capsule with its per-level color', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="auto"
          autoReviewEnabled={false}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })
    const capsule = container.querySelector('[data-testid="profile-capsule"]')
    expect(capsule?.textContent).toContain('Auto')
    expect(capsule?.getAttribute('class')).toContain('text-blue-600')

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="full"
          autoReviewEnabled={false}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })
    const fullCapsule = container.querySelector('[data-testid="profile-capsule"]')
    expect(fullCapsule?.textContent).toContain('Full access')
    expect(fullCapsule?.getAttribute('class')).toContain('text-amber-600')
  })

  it('renders the compact Full access label as a warning', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })
    const row = findButton('Full access')

    const title = row.querySelector('span.text-\\[13px\\]')
    expect(title?.getAttribute('class')).toContain('text-amber-600')
    expect(row.querySelector('span.text-\\[11px\\]')).toBeNull()
  })

  it('hides the non-default dot at defaults and shows it for a non-default profile', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })
    expect(container.querySelector('[data-testid="controls-nondefault-dot"]')).toBeNull()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="auto"
          autoReviewEnabled={false}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })
    expect(container.querySelector('[data-testid="controls-nondefault-dot"]')).not.toBeNull()
  })

  it('shows the non-default dot when auto-review is enabled at the default profile', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={true}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-testid="controls-nondefault-dot"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="auto-review-switch"]')?.getAttribute('data-checked')
    ).toBe('true')
  })

  it('toggles auto-review from the menu row without closing the menu', () => {
    const onAutoReviewChange = vi.fn()
    const onProfileChange = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          onProfileChange={onProfileChange}
          onAutoReviewChange={onAutoReviewChange}
        />
      )
    })
    act(() => findButton('Auto-review').click())

    expect(onAutoReviewChange).toHaveBeenCalledWith(true)
    // The row must not bubble into a profile change or close the menu (preventDefault).
    expect(onProfileChange).not.toHaveBeenCalled()
    expect(selectEvents.at(-1)?.prevented).toBe(true)
  })

  it('does not toggle auto-review while the row is disabled', () => {
    const onAutoReviewChange = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          autoReviewDisabled={true}
          onProfileChange={vi.fn()}
          onAutoReviewChange={onAutoReviewChange}
        />
      )
    })
    const row = findButton('Auto-review')
    expectStandingDisabled(row, true)

    act(() => row.click())

    expect(onAutoReviewChange).not.toHaveBeenCalled()
  })

  it('stays browsable but disables every mutating control in read-only mode', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          readOnly={true}
          grants={[
            { categoryKey: 'shell:git', label: 'git status', kind: 'shell', scope: 'session' }
          ]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    // The trigger stays enabled so the menu and the permission submenu remain browsable.
    const trigger = container.querySelector('[data-testid="composer-controls-trigger"]')
    expect(trigger?.hasAttribute('disabled')).toBe(false)

    // Every mutating control is disabled: profile items, auto-review row, grant actions.
    expectStandingDisabled(findButton('Ask for approval'), true)
    expectStandingDisabled(findButton('Auto-review'), true)

    const clearButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Clear all session grants'
    )
    const revokeButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Revoke session grant for git status'
    )
    expect(clearButton?.disabled).toBe(true)
    expect(revokeButton?.disabled).toBe(true)
  })

  it('keeps only permission mode editable when other agent controls are read-only', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          readOnly={true}
          permissionProfileReadOnly={false}
          enabledComputeHosts={[]}
          showSpecialist
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostEnabledChange={vi.fn()}
          onComputeHostSelectedChange={vi.fn()}
        />
      )
    })

    expectStandingDisabled(findButton('Auto-approve edits'), false)
    expectStandingDisabled(findButton('Auto-review'), true)
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="compute-host-enabled-ssh:cluster-1"]'
      )?.disabled
    ).toBe(true)
    expect(
      container
        .querySelector('[data-testid="specialist-submenu-stub"]')
        ?.getAttribute('data-read-only')
    ).toBe('true')
  })

  it('keeps replay-independent controls editable while provider controls stay locked', () => {
    const onAutoReviewChange = vi.fn()
    const onMemoryChange = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          memoryEnabled={false}
          readOnly={true}
          autoReviewReadOnly={false}
          memoryReadOnly={false}
          specialistReadOnly={false}
          onProfileChange={vi.fn()}
          onAutoReviewChange={onAutoReviewChange}
          onMemoryChange={onMemoryChange}
          showSpecialist
          onSpecialistChange={vi.fn()}
        />
      )
    })

    const autoReviewRow = findButton('Auto-review')
    expectStandingDisabled(autoReviewRow, false)
    const memoryRow = findButton('Memory')
    expectStandingDisabled(memoryRow, false)
    expect(
      container
        .querySelector('[data-testid="specialist-submenu-stub"]')
        ?.getAttribute('data-read-only')
    ).toBe('false')

    act(() => autoReviewRow.click())
    act(() => memoryRow.click())

    expect(onAutoReviewChange).toHaveBeenCalledWith(true)
    expect(onMemoryChange).toHaveBeenCalledWith(true)
  })

  it('keeps conversation grant actions available while profile controls are read-only', () => {
    const onRevokeGrant = vi.fn()
    const onClearGrants = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          readOnly={true}
          grantActionsReadOnly={false}
          grants={[
            {
              categoryKey: 'shell:execute',
              label: 'Shell commands',
              kind: 'shell',
              scope: 'session'
            }
          ]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onRevokeGrant={onRevokeGrant}
          onClearGrants={onClearGrants}
        />
      )
    })

    expectStandingDisabled(findButton('Ask for approval'), true)

    const clearButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Clear all session grants'
    )
    const revokeButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) =>
        candidate.getAttribute('aria-label') === 'Revoke session grant for Shell commands'
    )
    expect(clearButton?.disabled).toBe(false)
    expect(revokeButton?.disabled).toBe(false)

    act(() => clearButton?.click())
    act(() => revokeButton?.click())
    expect(onClearGrants).toHaveBeenCalledTimes(1)
    expect(onRevokeGrant).toHaveBeenCalledWith('shell:execute')
  })

  it('presents each host with direct Enable and Run state controls', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={['ssh:cluster-1']}
          selectedComputeHosts={['ssh:cluster-1']}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostEnabledChange={vi.fn()}
          onComputeHostSelectedChange={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('SSH')
    expect(container.textContent).toContain('cluster-1')
    expect(container.textContent).toContain('gpu-box')
    expect(container.textContent).not.toContain('Session access')
    expect(container.textContent).not.toContain('Available to Agent')
    expect(container.textContent).not.toContain('Hidden from Agent')
    const enabledControl = container.querySelector<HTMLButtonElement>(
      '[data-testid="compute-host-enabled-ssh:cluster-1"]'
    )
    const runControl = container.querySelector<HTMLButtonElement>(
      '[data-testid="compute-host-selected-ssh:cluster-1"]'
    )
    expect(enabledControl?.textContent).toBe('')
    expect(runControl?.textContent).toBe('')
    expect(enabledControl?.getAttribute('aria-label')).toBe('Disable cluster-1')
    expect(
      enabledControl
        ?.querySelector('[data-testid="auto-review-switch"]')
        ?.getAttribute('data-checked')
    ).toBe('true')
    expect(enabledControl?.parentElement?.className).toContain('min-h-8')
    expect(enabledControl?.parentElement?.className).toContain('py-0.5')
    expect(runControl?.getAttribute('role')).toBe('menuitemcheckbox')
    expect(runControl?.getAttribute('aria-checked')).toBe('true')
    expect(runControl?.getAttribute('aria-label')).toBe('Remove cluster-1 from run targets')
    expect(container.textContent).toContain('Remove from target hosts')
    expect(container.textContent).toContain('Select as target host to run jobs')
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="compute-host-selected-ssh:gpu-box"]'
      )?.disabled
    ).toBe(false)
    expect(container.textContent).toContain('Manage compute...')
  })

  it('keeps the Compute summary stable when host state changes', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={['ssh:cluster-1', 'ssh:gpu-box']}
          selectedComputeHosts={['ssh:cluster-1', 'ssh:gpu-box']}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostEnabledChange={vi.fn()}
          onComputeHostSelectedChange={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('Run jobs on a remote SSH host, or manage hosts.')
    expect(container.textContent).not.toContain('2 execution targets selected.')
  })

  it('enables a hidden host as Available without selecting it', () => {
    const onComputeHostEnabledChange = vi.fn()
    const onComputeHostSelectedChange = vi.fn()
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={[]}
          selectedComputeHosts={[]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostEnabledChange={onComputeHostEnabledChange}
          onComputeHostSelectedChange={onComputeHostSelectedChange}
        />
      )
    })

    const enable = container.querySelector<HTMLButtonElement>(
      '[data-testid="compute-host-enabled-ssh:cluster-1"]'
    )
    act(() => enable?.click())

    expect(onComputeHostEnabledChange).toHaveBeenCalledWith('ssh:cluster-1', true)
    expect(onComputeHostSelectedChange).not.toHaveBeenCalled()
  })

  it('toggles multiple enabled hosts in the Selected execution target pool independently', () => {
    const onComputeHostSelectedChange = vi.fn()
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={['ssh:cluster-1', 'ssh:gpu-box']}
          selectedComputeHosts={['ssh:cluster-1']}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostEnabledChange={vi.fn()}
          onComputeHostSelectedChange={onComputeHostSelectedChange}
        />
      )
    })

    const cluster = container.querySelector<HTMLButtonElement>(
      '[data-testid="compute-host-selected-ssh:cluster-1"]'
    )
    const gpu = container.querySelector<HTMLButtonElement>(
      '[data-testid="compute-host-selected-ssh:gpu-box"]'
    )
    act(() => cluster?.click())
    act(() => gpu?.click())

    expect(onComputeHostSelectedChange).toHaveBeenNthCalledWith(1, 'ssh:cluster-1', false)
    expect(onComputeHostSelectedChange).toHaveBeenNthCalledWith(2, 'ssh:gpu-box', true)
  })

  it('allows Run to select a host before it is enabled', () => {
    const onComputeHostSelectedChange = vi.fn()
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={[]}
          selectedComputeHosts={[]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostEnabledChange={vi.fn()}
          onComputeHostSelectedChange={onComputeHostSelectedChange}
        />
      )
    })

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="compute-host-selected-ssh:cluster-1"]')
        ?.click()
    )

    expect(onComputeHostSelectedChange).toHaveBeenCalledWith('ssh:cluster-1', true)
  })

  it('disables a selected host through the primary Session access control', () => {
    const onComputeHostEnabledChange = vi.fn()
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={['ssh:cluster-1']}
          selectedComputeHosts={['ssh:cluster-1']}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostEnabledChange={onComputeHostEnabledChange}
          onComputeHostSelectedChange={vi.fn()}
        />
      )
    })

    const disable = container.querySelector<HTMLButtonElement>(
      '[data-testid="compute-host-enabled-ssh:cluster-1"]'
    )
    act(() => disable?.click())

    expect(onComputeHostEnabledChange).toHaveBeenCalledWith('ssh:cluster-1', false)
  })

  it('opens the settings panel from Manage compute...', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={[]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    act(() => findButton('Manage compute...').click())

    expect(useSettingsStore.getState().openSettingsToCompute).toHaveBeenCalledTimes(1)
  })

  it('disables host rows in read-only mode', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          readOnly={true}
          enabledComputeHosts={[]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="compute-host-enabled-ssh:cluster-1"]'
      )?.disabled
    ).toBe(true)
  })

  it('renders a Compute submenu trigger above the SSH hosts', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={[]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostEnabledChange={vi.fn()}
          onComputeHostSelectedChange={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('Compute')
    // SSH hosts + Manage compute stay nested under that single Compute submenu.
    expect(container.textContent).toContain('SSH')
    expect(container.textContent).toContain('Manage compute...')
  })

  it('folds Compute into a hover submenu that holds the SSH hosts and Manage compute', () => {
    // Regression guard (#545 flattened Compute into the primary panel): Compute must be a
    // single hover-expandable row whose content holds the host list, and the top-level order
    // stays permission mode -> session grants -> auto-review -> specialist -> compute.
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          grants={[
            { categoryKey: 'shell:git', label: 'git status', kind: 'shell', scope: 'session' }
          ]}
          enabledComputeHosts={[]}
          showSpecialist
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostEnabledChange={vi.fn()}
          onComputeHostSelectedChange={vi.fn()}
        />
      )
    })

    // The Compute row is a hover submenu trigger, never a static label in the primary panel.
    const computeTriggers = Array.from(
      container.querySelectorAll('[data-testid="submenu-trigger"]')
    ).filter((el) => el.textContent?.includes('Compute'))
    expect(computeTriggers).toHaveLength(1)

    // SSH hosts and Manage compute live inside that submenu's content, reached on hover.
    const computeSubContents = Array.from(
      container.querySelectorAll('[data-testid="submenu-content"]')
    ).filter((el) => el.textContent?.includes('cluster-1'))
    expect(computeSubContents).toHaveLength(1)
    expect(computeSubContents[0]?.textContent).toContain('Manage compute...')

    // Top-level order: permission mode -> session grants -> divider -> auto-review -> specialist -> compute.
    const orderAnchor = (needle: string): Element => {
      const match = Array.from(container.querySelectorAll('[data-testid="submenu-trigger"]')).find(
        (el) => el.textContent?.includes(needle)
      )
      if (!match) throw new Error(`submenu trigger not found: ${needle}`)
      return match
    }
    const permissionTrigger = orderAnchor('Permission mode')
    const computeTrigger = computeTriggers[0] as Element
    const autoReviewRow = findButton('Auto-review')
    const sessionGrantsHeading = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'Allowed this session'
    )
    const specialistStub = container.querySelector('[data-testid="specialist-submenu-stub"]')
    expect(sessionGrantsHeading).not.toBeUndefined()
    expect(specialistStub).not.toBeNull()

    const precedes = (a: Element, b: Element): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    const autoReviewDivider = Array.from(container.querySelectorAll('hr')).find(
      (separator) =>
        precedes(sessionGrantsHeading as Element, separator) && precedes(separator, autoReviewRow)
    )
    expect(precedes(permissionTrigger, sessionGrantsHeading as Element)).toBe(true)
    expect(autoReviewDivider).not.toBeUndefined()
    expect(precedes(autoReviewRow, specialistStub as Element)).toBe(true)
    expect(precedes(specialistStub as Element, computeTrigger)).toBe(true)
  })

  it('does not render the specialist submenu when showSpecialist is false', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-testid="specialist-submenu-stub"]')).toBeNull()
  })

  it('renders the specialist submenu and forwards its props when showSpecialist is true', () => {
    const onSpecialistChange = vi.fn()
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          showSpecialist
          specialistId="uuid-1"
          specialistUnavailable={false}
          specialistReadOnly={false}
          onSpecialistChange={onSpecialistChange}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    const stub = container.querySelector('[data-testid="specialist-submenu-stub"]')
    expect(stub).not.toBeNull()
    expect(stub?.getAttribute('data-selected-id')).toBe('uuid-1')
  })

  it('locks the specialist submenu down while a session is running', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          readOnly
          showSpecialist
          specialistId="uuid-1"
          onSpecialistChange={vi.fn()}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    const stub = container.querySelector('[data-testid="specialist-submenu-stub"]')
    expect(stub?.getAttribute('data-read-only')).toBe('true')
  })
})
