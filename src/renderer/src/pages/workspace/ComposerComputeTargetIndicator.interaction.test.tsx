// @vitest-environment jsdom
import { act, cloneElement, isValidElement, type PropsWithChildren, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../../shared/compute'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'

import { ComposerComputeTargetIndicator } from './ComposerComputeTargetIndicator'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  Tooltip: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  TooltipTrigger: ({
    children,
    onFocus
  }: PropsWithChildren<{ onFocus?: React.FocusEventHandler<HTMLElement> }>): React.JSX.Element => {
    if (!isValidElement(children)) return <>{children}</>
    return cloneElement(children as ReactElement<Record<string, unknown>>, { onFocus })
  },
  TooltipContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div role="tooltip">{children}</div>
  )
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  PopoverTrigger: ({
    children,
    asChild,
    ...props
  }: PropsWithChildren<{
    asChild?: boolean
    onFocus?: React.FocusEventHandler<HTMLElement>
  }>): React.JSX.Element => {
    void asChild
    if (!isValidElement(children)) return <>{children}</>
    return cloneElement(children as ReactElement<Record<string, unknown>>, props)
  },
  PopoverContent: ({
    children,
    className,
    'data-testid': testId
  }: PropsWithChildren<{
    className?: string
    'data-testid'?: string
  }>): React.JSX.Element => (
    <div className={className} data-testid={testId}>
      {children}
    </div>
  )
}))

const host: ComputeHost = {
  id: 'host-1',
  providerId: 'ssh:cedar-gpu',
  displayName: 'Cedar GPU',
  shape: 'direct_ssh',
  sshAlias: 'cedar-gpu',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({ ...createInitialComputeState(), hosts: [host], isLoaded: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ComposerComputeTargetIndicator', () => {
  it('projects the execution target beside the Specialist control and reopens Compute selection', () => {
    const onOpenTarget = vi.fn()
    const onOpenSettings = vi.fn()

    act(() => {
      root.render(
        <ComposerComputeTargetIndicator
          targetProviderIds={['ssh:cedar-gpu']}
          onOpenTarget={onOpenTarget}
          onOpenSettings={onOpenSettings}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>('button')
    expect(button?.getAttribute('aria-label')).toBe('Compute execution target: Cedar GPU')
    expect(button?.dataset.slot).toBe('button')
    expect(button?.dataset.variant).toBe('ghost')
    expect(button?.dataset.size).toBe('icon')
    expect(button?.textContent).toContain('1')
    const content = container.querySelector('[data-testid="composer-compute-target-content"]')
    expect(content?.textContent).toContain('Cedar GPU')
    expect(content?.textContent).toContain('Selected hosts are used to run jobs.')

    const settingsButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-compute-settings-ssh:cedar-gpu"]'
    )
    act(() => settingsButton?.click())
    expect(settingsButton?.getAttribute('aria-label')).toBe('Open settings for Cedar GPU')
    expect(settingsButton?.className).toContain('size-5')
    expect(
      settingsButton?.closest('[data-testid="composer-compute-target-row"]')?.className
    ).toContain('min-h-6')
    expect(onOpenSettings).toHaveBeenCalledWith('ssh:cedar-gpu')

    const changeTargetsButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-compute-change-targets"]'
    )
    act(() => changeTargetsButton?.click())
    expect(onOpenTarget).toHaveBeenCalledTimes(1)

    const focusEvent = new FocusEvent('focusin', { bubbles: true, cancelable: true })
    vi.spyOn(button as HTMLButtonElement, 'matches').mockReturnValue(false)
    act(() => button?.dispatchEvent(focusEvent))
    expect(focusEvent.defaultPrevented).toBe(true)
  })

  it('summarizes multiple selected execution targets without assigning priority', () => {
    useComputeStore.setState((state) => ({
      ...state,
      hosts: [
        host,
        {
          ...host,
          id: 'host-2',
          providerId: 'ssh:atlas',
          displayName: 'Atlas'
        }
      ]
    }))

    act(() => {
      root.render(
        <ComposerComputeTargetIndicator
          targetProviderIds={['ssh:cedar-gpu', 'ssh:atlas']}
          onOpenTarget={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-compute-target-trigger"]'
    )
    expect(button?.getAttribute('aria-label')).toBe('Compute execution targets: Cedar GPU, Atlas')
    expect(button?.textContent).toContain('2')
    const targetRows = Array.from(
      container.querySelectorAll('[data-testid="composer-compute-target-row"]')
    ).map((row) => row.firstElementChild?.textContent)
    expect(targetRows).toEqual(['Cedar GPU', 'Atlas'])
    expect(container.querySelectorAll('[data-testid^="composer-compute-settings-"]')).toHaveLength(
      2
    )
  })

  it('stays hidden without a selected execution target', () => {
    act(() => {
      root.render(
        <ComposerComputeTargetIndicator
          targetProviderIds={[]}
          onOpenTarget={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      )
    })

    expect(container.innerHTML).toBe('')
  })
})
