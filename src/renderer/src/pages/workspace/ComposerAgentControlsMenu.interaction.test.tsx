// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerAgentControlsMenu } from './ComposerAgentControlsMenu'

import type { ComputeHost } from '../../../../shared/compute'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Select events fired through the mocked menu items, so tests can assert preventDefault
// (i.e. the row keeps the real menu open instead of closing it).
const { selectEvents } = vi.hoisted(() => ({
  selectEvents: [] as Array<{ preventDefault: () => void; prevented: boolean }>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
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
  DropdownMenuSub: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: PropsWithChildren<{
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
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

vi.mock('radix-ui', () => ({
  AlertDialog: {
    Root: ({ open, children }: PropsWithChildren<{ open?: boolean }>): React.JSX.Element | null =>
      open ? <div>{children}</div> : null,
    Portal: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
    Overlay: (): React.JSX.Element => <div />,
    Content: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
    Title: ({ children }: PropsWithChildren): React.JSX.Element => <h2>{children}</h2>,
    Description: ({ children }: PropsWithChildren): React.JSX.Element => <p>{children}</p>,
    Cancel: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
    Action: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>
  }
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

describe('ComposerAgentControlsMenu', () => {
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
      'Agent controls: Ask for approval, auto-review off'
    )
    act(() =>
      findButton(
        'Auto-approve editsAuto-approve edits to files in the workspace. Still ask before commands, network, and MCP.'
      ).click()
    )

    expect(onProfileChange).toHaveBeenCalledWith('auto')
    expect(container.textContent).not.toContain('Enable Full access?')
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
    act(() =>
      findButton(
        'Full accessRun everything without prompts, including commands and network.'
      ).click()
    )

    expect(onProfileChange).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Enable Full access?')
    expect(findButton('Cancel').getAttribute('data-slot')).toBe('button')
    expect(findButton('Cancel').getAttribute('data-variant')).toBe('outline')
    expect(findButton('Enable').getAttribute('data-slot')).toBe('button')

    act(() => findButton('Enable').click())
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

    expect(
      findButton('Full accessThe current agent does not support native bypass mode.').disabled
    ).toBe(true)
  })

  it('lists session grants and revokes the clicked one', () => {
    const onRevokeGrant = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          grants={[
            { categoryKey: 'shell:git', label: 'git status', kind: 'shell' },
            { categoryKey: 'mcp:search', label: 'search papers', kind: 'mcp' }
          ]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onRevokeGrant={onRevokeGrant}
        />
      )
    })

    expect(container.textContent).toContain('Always allowed this session')
    expect(container.textContent).toContain('git status')

    const revokeButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Revoke always-allow for git status'
    )

    if (!revokeButton) throw new Error('revoke button not found')

    act(() => revokeButton.click())

    expect(onRevokeGrant).toHaveBeenCalledWith('shell:git')
  })

  it('clears all grants when Clear all is clicked', () => {
    const onClearGrants = vi.fn()

    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          grants={[
            { categoryKey: 'shell:git', label: 'git status', kind: 'shell' },
            { categoryKey: 'tool:Write', label: 'Write', kind: 'tool' }
          ]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onClearGrants={onClearGrants}
        />
      )
    })

    const clearButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Clear all always-allow grants'
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

  it('renders the Full access submenu row as a warning in amber', () => {
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
    const row = findButton(
      'Full accessRun everything without prompts, including commands and network.'
    )

    const title = row.querySelector('span.text-\\[13px\\]')
    const description = row.querySelector('span.text-\\[11px\\]')
    expect(title?.getAttribute('class')).toContain('text-amber-600')
    expect(description?.getAttribute('class')).toContain('text-amber-600/70')
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
    act(() =>
      findButton('Auto-reviewA reviewer agent checks every change before it lands.').click()
    )

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
    const row = findButton('Auto-reviewA reviewer agent checks every change before it lands.')
    expect(row.disabled).toBe(true)

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
          grants={[{ categoryKey: 'shell:git', label: 'git status', kind: 'shell' }]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
        />
      )
    })

    // The trigger stays enabled so the menu and the permission submenu remain browsable.
    const trigger = container.querySelector('[data-testid="composer-controls-trigger"]')
    expect(trigger?.hasAttribute('disabled')).toBe(false)

    // Every mutating control is disabled: profile items, auto-review row, grant actions.
    expect(
      findButton('Ask for approvalAsk before file edits, commands, network, and MCP tools.')
        .disabled
    ).toBe(true)
    expect(
      findButton('Auto-reviewA reviewer agent checks every change before it lands.').disabled
    ).toBe(true)

    const clearButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Clear all always-allow grants'
    )
    const revokeButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Revoke always-allow for git status'
    )
    expect(clearButton?.disabled).toBe(true)
    expect(revokeButton?.disabled).toBe(true)
  })

  it('renders SSH hosts from the compute store under the compute section', () => {
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={[]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostToggle={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('SSH')
    expect(container.textContent).toContain('cluster-1')
    expect(container.textContent).toContain('gpu-box')
    expect(container.textContent).toContain('Manage compute...')
  })

  it('calls onComputeHostToggle with (providerId, true) when enabling a host', () => {
    const onComputeHostToggle = vi.fn()
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={[]}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostToggle={onComputeHostToggle}
        />
      )
    })

    act(() => findButton('cluster-1').click())

    expect(onComputeHostToggle).toHaveBeenCalledWith('ssh:cluster-1', true)
  })

  it('calls onComputeHostToggle with (providerId, false) when disabling an enabled host', () => {
    const onComputeHostToggle = vi.fn()
    act(() => {
      root.render(
        <ComposerAgentControlsMenu
          profile="ask"
          autoReviewEnabled={false}
          enabledComputeHosts={['ssh:cluster-1']}
          onProfileChange={vi.fn()}
          onAutoReviewChange={vi.fn()}
          onComputeHostToggle={onComputeHostToggle}
        />
      )
    })

    act(() => findButton('cluster-1').click())

    expect(onComputeHostToggle).toHaveBeenCalledWith('ssh:cluster-1', false)
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

    expect(findButton('cluster-1').disabled).toBe(true)
  })
})
