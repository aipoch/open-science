// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const escapeBoundary = vi.hoisted(() => ({
  initial: undefined as ((event: KeyboardEvent) => void) | undefined
}))

vi.mock('radix-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('radix-ui')>()),
  Dialog: {
    Root: ({ open, children }: PropsWithChildren<{ open?: boolean }>) => (
      <div data-testid="dialog-root" data-open={String(open)}>
        {children}
      </div>
    ),
    Portal: ({ children }: PropsWithChildren) => <>{children}</>,
    Overlay: () => <div />,
    Content: ({
      children,
      onEscapeKeyDown
    }: PropsWithChildren<{
      onEscapeKeyDown?: (event: KeyboardEvent) => void
    }>): React.JSX.Element => {
      // Model the retained callback observed at the real Radix boundary.
      escapeBoundary.initial ??= onEscapeKeyDown
      return <div role="dialog">{children}</div>
    },
    Title: ({ children }: PropsWithChildren) => <h2>{children}</h2>,
    Description: ({ children }: PropsWithChildren) => <p>{children}</p>,
    Close: ({ children }: PropsWithChildren) => <>{children}</>
  }
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    size,
    variant,
    ...props
  }: PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>> & {
    size?: string
    variant?: string
  }) => (
    <button data-slot="button" data-size={size} data-variant={variant} {...props}>
      {children}
    </button>
  )
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

import { UpdateDialog } from './UpdateDialog'

const originalApply = useUpdateStore.getState().apply
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  escapeBoundary.initial = undefined
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useUpdateStore.setState({
    isDialogOpen: false,
    status: { state: 'idle', current: '' },
    apply: originalApply
  })
  if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

describe('UpdateDialog closing lifecycle', () => {
  it('keeps an earlier Escape callback current without applying an unconfirmed recovery', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
    const apply = vi.fn().mockResolvedValue(undefined)
    useUpdateStore.setState({
      isDialogOpen: true,
      apply,
      status: {
        state: 'ready',
        current: '0.1.0',
        latest: '0.2.0',
        error: 'Could not fully stop background processes before updating. Please try again.',
        legacyShellRecovery: { token: 'reviewed-lifecycle', count: 2 }
      }
    })
    act(() => root.render(<UpdateDialog />))
    const retainedEscape = escapeBoundary.initial!
    const recover = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Back up records and retry'
    )!
    act(() => recover.click())

    const composingEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      isComposing: true,
      cancelable: true
    })
    act(() => retainedEscape(composingEscape))
    expect(composingEscape.defaultPrevented).toBe(true)
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()

    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    act(() => retainedEscape(escape))
    expect(escape.defaultPrevented).toBe(true)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(useUpdateStore.getState().isDialogOpen).toBe(true)
    expect(apply).not.toHaveBeenCalled()

    const nextEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    act(() => retainedEscape(nextEscape))
    expect(nextEscape.defaultPrevented).toBe(false)

    act(() => recover.click())
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')
    ).find((button) => button.textContent === 'Back up records and retry')!
    act(() => confirm.click())
    expect(apply).toHaveBeenCalledExactlyOnceWith({
      legacyShellRecoveryToken: 'reviewed-lifecycle'
    })
  })

  it('keeps the last update content mounted while the controlled dialog closes', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'available',
        current: '0.1.0',
        latest: '0.2.0',
        totalBytes: 12.5 * 1024 * 1024
      }
    })
    act(() => root.render(<UpdateDialog />))

    act(() => {
      useUpdateStore.setState({
        isDialogOpen: false,
        status: { state: 'idle', current: '0.1.0' }
      })
    })

    expect(container.querySelector('[data-testid="dialog-root"]')?.getAttribute('data-open')).toBe(
      'false'
    )
    expect(container.textContent).toContain('v0.2.0')
    expect(container.textContent).toContain('Download update (12.5 MB)')
  })

  it('uses the shared icon button sizing for the title-bar close control', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' }
    })
    act(() => root.render(<UpdateDialog />))

    const closeButton = container.querySelector<HTMLButtonElement>('[aria-label="Close"]')

    expect(closeButton?.getAttribute('data-slot')).toBe('button')
    expect(closeButton?.getAttribute('data-size')).toBe('icon-sm')
    expect(closeButton?.getAttribute('data-variant')).toBe('ghost')
  })
})
