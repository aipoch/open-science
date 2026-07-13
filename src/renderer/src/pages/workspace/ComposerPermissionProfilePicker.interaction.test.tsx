// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerPermissionProfilePicker } from './ComposerPermissionProfilePicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: PropsWithChildren<{ disabled?: boolean; onSelect?: () => void }>): React.JSX.Element => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
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

const findButton = (label: string): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )

  if (!button) throw new Error(`button not found: ${label}`)

  return button
}

describe('ComposerPermissionProfilePicker', () => {
  it('changes Ask and Auto directly without a risk dialog', () => {
    const onChange = vi.fn()

    act(() => {
      root.render(
        <ComposerPermissionProfilePicker value="ask" onChange={onChange} disabled={false} />
      )
    })
    act(() => findButton('Approve for meAutomatically approve only low-risk operations.').click())

    expect(onChange).toHaveBeenCalledWith('auto')
    expect(container.textContent).not.toContain('Enable Full access?')
  })

  it('requires explicit confirmation before enabling Full access', () => {
    const onChange = vi.fn()

    act(() => {
      root.render(<ComposerPermissionProfilePicker value="ask" onChange={onChange} />)
    })
    act(() => findButton('Full accessRun without approval prompts in this conversation.').click())

    expect(onChange).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Enable Full access?')

    act(() => findButton('Enable Full access').click())
    expect(onChange).toHaveBeenCalledWith('full')
  })

  it('disables Full access when the attached Agent does not advertise bypass mode', () => {
    act(() => {
      root.render(
        <ComposerPermissionProfilePicker
          value="ask"
          state={{
            selectedProfile: 'ask',
            effectiveProfile: 'ask',
            currentModeId: 'default',
            availableModeIds: ['default'],
            fullAccessAvailable: false
          }}
          onChange={vi.fn()}
        />
      )
    })

    expect(
      findButton('Full accessThe current agent does not support native bypass mode.').disabled
    ).toBe(true)
  })
})
