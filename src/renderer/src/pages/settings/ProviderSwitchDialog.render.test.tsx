import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

type ElementWithProps = ReactElement<Record<string, unknown>>

const collectElements = (node: ReactNode): ElementWithProps[] => {
  const elements: ElementWithProps[] = []

  const visit = (value: ReactNode): void => {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) return

      const element = child as ElementWithProps
      elements.push(element)
      visit(element.props.children as ReactNode)
    })
  }

  visit(node)
  return elements
}

const getTextContent = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement(node)) return ''

  return Children.toArray((node as ElementWithProps).props.children as ReactNode)
    .map(getTextContent)
    .join('')
}

describe('ProviderSwitchDialog wiring', () => {
  it('routes cancel via the overlay close and confirm via the action button', async () => {
    const { ProviderSwitchDialog } = await import('./ProviderSwitchDialog')
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const tree = ProviderSwitchDialog({ open: true, runningCount: 1, onCancel, onConfirm })
    const elements = collectElements(tree)
    const root = elements[0]
    const confirmButton = elements.find(
      (element) =>
        getTextContent(element).trim() === 'Interrupt and switch' && element.props.onClick
    )

    // Dismissing the dialog (Esc / overlay) reports a cancel and changes nothing.
    expect(root.props.onOpenChange).toBeTypeOf('function')
    ;(root.props.onOpenChange as (open: boolean) => void)(false)
    expect(onCancel).toHaveBeenCalledOnce()

    expect(confirmButton?.props.onClick).toBeTypeOf('function')
    ;(confirmButton?.props.onClick as () => void)()
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('describes a single running session in the interrupt warning', async () => {
    const { ProviderSwitchDialog } = await import('./ProviderSwitchDialog')
    const tree = ProviderSwitchDialog({
      open: true,
      runningCount: 1,
      onCancel: vi.fn(),
      onConfirm: vi.fn()
    })

    expect(getTextContent(tree)).toContain('A session is currently running')
    expect(getTextContent(tree)).toContain('interrupt the in-progress turn')
  })

  it('pluralizes the warning for multiple running sessions', async () => {
    const { ProviderSwitchDialog } = await import('./ProviderSwitchDialog')
    const tree = ProviderSwitchDialog({
      open: true,
      runningCount: 3,
      onCancel: vi.fn(),
      onConfirm: vi.fn()
    })

    expect(getTextContent(tree)).toContain('3 sessions are currently running')
  })
})
