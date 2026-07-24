// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('radix-ui', () => ({
  Dialog: {
    Root: ({ open, children }: PropsWithChildren<{ open?: boolean }>) => (
      <div data-testid="dialog-root" data-open={String(open)}>
        {children}
      </div>
    ),
    Portal: ({ children }: PropsWithChildren) => <>{children}</>,
    Overlay: () => <div />,
    Content: ({ children }: PropsWithChildren) => <div role="dialog">{children}</div>,
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
  useUpdateStore.setState({ isDialogOpen: false, status: { state: 'idle', current: '' } })
})

describe('UpdateDialog closing lifecycle', () => {
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
