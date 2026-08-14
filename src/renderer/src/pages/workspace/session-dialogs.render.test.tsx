import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import type { ChatSession } from '@/stores/session-store'
import { expectDialogFormFieldClassName } from '@/test-utils/dialog-form'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />
}))

// These structure tests call the components as pure functions; lifecycle behavior is covered by the
// retained-value tests, so keep this test focused on callback and chrome wiring.
vi.mock('@/components/ui/use-retained-dialog-value', () => ({
  useRetainedDialogValue: <T,>(value: T | null | undefined): T | undefined => value ?? undefined
}))

type ElementWithProps = ReactElement<Record<string, unknown>>

const createSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Notebook review',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

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

describe('workspace session dialogs behavior wiring', () => {
  const findPanel = (elements: ElementWithProps[]): ElementWithProps | undefined =>
    elements.find((element) =>
      String(element.props.className ?? '').includes('rounded-xl border border-border bg-card')
    )

  const expectSettingsDialogChrome = (
    tree: ReactNode,
    expectedWidth: string,
    expectedClose: () => void,
    options: { interceptsOutsideClick?: boolean } = { interceptsOutsideClick: true }
  ): void => {
    const elements = collectElements(tree)
    const overlay = elements.find((element) =>
      String(element.props.className ?? '').includes('bg-black/50')
    )
    const panel = findPanel(elements)
    const closeButton = elements.find((element) => element.props['aria-label'] === 'Close')
    const header = elements.find((element) =>
      String(element.props.className ?? '').includes('border-b border-border-300/90')
    )
    const footer = elements.find((element) =>
      String(element.props.className ?? '').includes('border-t border-border-300/90')
    )
    const title = elements.find((element) =>
      String(element.props.className ?? '').includes('text-lg font-semibold text-text-000')
    )
    const body = elements.find((element) => String(element.props.className ?? '').includes('p-5'))

    expect(overlay?.props.className).not.toContain('backdrop-blur')
    expect(panel?.props.className).toContain(expectedWidth)
    expect(panel?.props.className).toContain('overflow-hidden')
    expect(panel?.props.className).toContain('text-foreground')
    expect(panel?.props.className).toContain('shadow-dialog')
    expect(header?.props.className).toContain('px-5 py-3.5')
    expect(footer?.props.className).toContain('px-5 py-3.5')
    expect(footer?.props.className).toContain('gap-3')
    expect(footer?.props.className).toContain('[&_button:enabled]:cursor-pointer')
    expect(title).toBeDefined()
    expect(body).toBeDefined()

    if (options.interceptsOutsideClick) {
      expect(panel?.props.onInteractOutside).toBeTypeOf('function')
      const outsideEvent = { preventDefault: vi.fn() }
      ;(panel?.props.onInteractOutside as (event: typeof outsideEvent) => void)(outsideEvent)
      expect(outsideEvent.preventDefault).toHaveBeenCalledOnce()
    }

    expect(closeButton?.props.onClick).toBe(expectedClose)
  }

  it('wires rename input, cancel, and submit callbacks', async () => {
    const { RenameSessionDialog } = await import('./RenameSessionDialog')
    const onRenameDraftChange = vi.fn()
    const onCancel = vi.fn()
    const onConfirmRename = vi.fn()
    const tree = RenameSessionDialog({
      session: createSession(),
      renameDraft: 'Notebook review',
      onRenameDraftChange,
      onCancel,
      onConfirmRename
    })
    const elements = collectElements(tree)
    const root = elements[0]
    const input = elements.find((element) => element.props['aria-label'] === 'Session name')
    const cancelButton = elements.find(
      (element) => getTextContent(element).trim() === 'Cancel' && element.props.onClick
    )
    const form = elements.find((element) => element.type === 'form')

    expect(root.props.onOpenChange).toBeTypeOf('function')
    ;(root.props.onOpenChange as (open: boolean) => void)(false)
    expect(onCancel).toHaveBeenCalledOnce()

    expect(input?.props.onChange).toBeTypeOf('function')
    expect(input?.props.id).toBe('rename-session-name')
    expectDialogFormFieldClassName(input?.props.className)
    expect(
      elements.find((element) => element.props.htmlFor === 'rename-session-name')?.props.className
    ).toContain('block text-sm font-medium text-foreground mb-1')
    ;(input?.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'Updated title' }
    })
    expect(onRenameDraftChange).toHaveBeenCalledWith('Updated title')

    expect(cancelButton?.props.onClick).toBeTypeOf('function')
    expect(cancelButton?.props.variant).toBe('ghost')
    expect(cancelButton?.props.className).toContain('cursor-pointer')
    expect(cancelButton?.props.className).toContain('border-0')
    expect(cancelButton?.props.className).toContain('shadow-none')
    expect(cancelButton?.props.className).toContain('hover:bg-bg-200')
    ;(cancelButton?.props.onClick as () => void)()
    expect(onCancel).toHaveBeenCalledTimes(2)

    expect(form?.props.onSubmit).toBeTypeOf('function')
    ;(form?.props.onSubmit as (event: unknown) => void)('submit-event')
    expect(onConfirmRename).toHaveBeenCalledWith('submit-event')
  })

  it('renders rename with settings dialog chrome and an explicit close control', async () => {
    const { RenameSessionDialog } = await import('./RenameSessionDialog')
    const onCancel = vi.fn()
    const tree = RenameSessionDialog({
      session: createSession(),
      renameDraft: 'Notebook review',
      onRenameDraftChange: vi.fn(),
      onCancel,
      onConfirmRename: vi.fn()
    })

    expectSettingsDialogChrome(tree, 'w-[min(420px,calc(100vw-2rem))]', onCancel)
  })

  it('wires delete close and confirm callbacks while rendering the session title', async () => {
    const { DeleteSessionDialog } = await import('./DeleteSessionDialog')
    const onCancel = vi.fn()
    const onConfirmDelete = vi.fn()
    const tree = DeleteSessionDialog({
      session: createSession({ title: 'Dataset cleanup' }),
      canDelete: true,
      onCancel,
      onConfirmDelete
    })
    const elements = collectElements(tree)
    const root = elements[0]
    const deleteButton = elements.find(
      (element) => getTextContent(element).trim() === 'Delete' && element.props.onClick
    )

    expect(getTextContent(tree)).toContain('Dataset cleanup')
    expect(root.props.onOpenChange).toBeTypeOf('function')
    ;(root.props.onOpenChange as (open: boolean) => void)(false)
    expect(onCancel).toHaveBeenCalledOnce()

    expect(deleteButton?.props.onClick).toBeTypeOf('function')
    ;(deleteButton?.props.onClick as () => void)()
    expect(onConfirmDelete).toHaveBeenCalledOnce()
  })

  it('renders delete with settings dialog chrome and an explicit close control', async () => {
    const { DeleteSessionDialog } = await import('./DeleteSessionDialog')
    const onCancel = vi.fn()
    const tree = DeleteSessionDialog({
      session: createSession({ title: 'Dataset cleanup' }),
      canDelete: true,
      onCancel,
      onConfirmDelete: vi.fn()
    })

    expectSettingsDialogChrome(tree, 'w-[min(420px,calc(100vw-2rem))]', onCancel, {
      interceptsOutsideClick: false
    })
  })

  it('disables Session deletion when persistence deletion recovery is unavailable', async () => {
    const { DeleteSessionDialog } = await import('./DeleteSessionDialog')
    const tree = DeleteSessionDialog({
      session: createSession({ title: 'Protected session' }),
      canDelete: false,
      onCancel: vi.fn(),
      onConfirmDelete: vi.fn()
    })
    const deleteButton = collectElements(tree).find(
      (element) => getTextContent(element).trim() === 'Delete' && element.props.onClick
    )

    expect(deleteButton?.props.disabled).toBe(true)
  })
})
