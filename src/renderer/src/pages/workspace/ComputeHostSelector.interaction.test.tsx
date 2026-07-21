// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../../shared/compute'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ComputeHostSelector } from './ComputeHostSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Radix DropdownMenu requires pointer-capture APIs that jsdom does not implement.
// Replace with a flat render so menu items are always visible in the DOM.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({
    children,
    onOpenChange
  }: PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>): React.JSX.Element => {
    // Simulate the menu being open immediately so its content renders.
    onOpenChange?.(true)
    return <div>{children}</div>
  },
  DropdownMenuTrigger: ({
    children,
    asChild
  }: PropsWithChildren<{ asChild?: boolean }>): React.JSX.Element => {
    void asChild
    return <>{children}</>
  },
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dropdown-label">{children}</div>
  ),
  DropdownMenuGroup: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dropdown-group">{children}</div>
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
      onClick={() => onSelect?.({ preventDefault: () => {} })}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: (): React.JSX.Element => <hr />
}))

// Replace Switch with a simple checkbox for interaction testing.
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    'aria-label': ariaLabel
  }: {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
    'aria-label'?: string
  }): React.JSX.Element => (
    <input
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  )
}))

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  // Prime stores with known state.
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

  // Provide a no-op openSettingsToCompute so the settings store is in a known state.
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    openSettingsToCompute: vi.fn() as () => void
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const findHostCheckbox = (label: string): HTMLInputElement => {
  const checkbox = Array.from(container.querySelectorAll('input[type="checkbox"]')).find((el) =>
    el.getAttribute('aria-label')?.includes(label)
  )
  if (!checkbox) throw new Error(`Checkbox for "${label}" not found`)
  return checkbox as HTMLInputElement
}

describe('ComputeHostSelector', () => {
  it('renders SSH hosts from the compute store', () => {
    act(() => {
      root.render(<ComputeHostSelector enabledHosts={[]} onToggle={vi.fn()} />)
    })

    // Both registered SSH hosts should be visible.
    expect(container.textContent).toContain('cluster-1')
    expect(container.textContent).toContain('gpu-box')
  })

  it('shows a checked switch for the currently enabled host', () => {
    act(() => {
      root.render(<ComputeHostSelector enabledHosts={['ssh:cluster-1']} onToggle={vi.fn()} />)
    })

    const enabledCheckbox = findHostCheckbox('Disable cluster-1')

    expect(enabledCheckbox.checked).toBe(true)
  })

  it('shows unchecked switches for disabled hosts', () => {
    act(() => {
      root.render(<ComputeHostSelector enabledHosts={[]} onToggle={vi.fn()} />)
    })

    const checkbox = findHostCheckbox('Enable cluster-1')

    expect(checkbox.checked).toBe(false)
  })

  it('calls onToggle with (providerId, true) when enabling a disabled host', () => {
    const onToggle = vi.fn()

    act(() => {
      root.render(<ComputeHostSelector enabledHosts={[]} onToggle={onToggle} />)
    })

    const checkbox = findHostCheckbox('Enable cluster-1')
    act(() => {
      checkbox.click()
    })

    expect(onToggle).toHaveBeenCalledWith('ssh:cluster-1', true)
  })

  it('calls onToggle with (providerId, false) when disabling an enabled host', () => {
    const onToggle = vi.fn()

    act(() => {
      root.render(<ComputeHostSelector enabledHosts={['ssh:cluster-1']} onToggle={onToggle} />)
    })

    const checkbox = findHostCheckbox('Disable cluster-1')
    act(() => {
      checkbox.click()
    })

    expect(onToggle).toHaveBeenCalledWith('ssh:cluster-1', false)
  })

  it('reflects the active host in the trigger aria-label when one is enabled', () => {
    act(() => {
      root.render(<ComputeHostSelector enabledHosts={['ssh:cluster-1']} onToggle={vi.fn()} />)
    })

    const trigger = container.querySelector('button[aria-label*="Compute:"]')

    expect(trigger?.getAttribute('aria-label')).toContain('cluster-1')
  })

  it('shows a placeholder aria-label when no host is enabled', () => {
    act(() => {
      root.render(<ComputeHostSelector enabledHosts={[]} onToggle={vi.fn()} />)
    })

    const trigger = container.querySelector('button[aria-label="Select compute host"]')

    expect(trigger).not.toBeNull()
  })

  it('shows "Manage compute..." item linking to settings', () => {
    act(() => {
      root.render(<ComputeHostSelector enabledHosts={[]} onToggle={vi.fn()} />)
    })

    expect(container.textContent).toContain('Manage compute...')
  })
})
