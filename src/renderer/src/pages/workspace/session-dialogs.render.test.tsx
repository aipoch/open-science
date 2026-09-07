import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import type { ChatSession } from '@/stores/session-store'
import { describe, expect, it, vi } from 'vitest'

import { createI18nTestStub } from '../../../../../test/i18n-test-stub'

vi.mock('react-i18next', () => createI18nTestStub())

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

vi.mock('@/components/ui/textarea', () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />
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

  it('edits title and description atomically with bounded fields and counters', async () => {
    const { EditSessionDialog } = await import('./EditSessionDialog')
    const onTitleDraftChange = vi.fn()
    const onDescriptionDraftChange = vi.fn()
    const onConfirmEdit = vi.fn()
    const tree = EditSessionDialog({
      session: createSession({ description: 'Existing summary' }),
      titleDraft: 'Notebook review',
      descriptionDraft: 'Existing summary',
      onTitleDraftChange,
      onDescriptionDraftChange,
      onCancel: vi.fn(),
      onConfirmEdit
    })
    const elements = collectElements(tree)
    const title = elements.find((element) => element.props.id === 'edit-session-title')
    const description = elements.find((element) => element.props.id === 'edit-session-description')
    const form = elements.find((element) => element.type === 'form')
    const closeTooltip = elements.find(
      (element) => typeof element.type === 'function' && element.type.name === 'TooltipContent'
    )
    const closeTooltipTrigger = elements.find(
      (element) => typeof element.props.onFocus === 'function'
    )

    expect(title?.props.maxLength).toBe(80)
    expect(description?.props.maxLength).toBe(1_000)
    expect(getTextContent(tree)).toContain('15/80')
    expect(getTextContent(tree)).toContain('16/1000')
    expect(getTextContent(closeTooltip)).toBe('Close')
    const focusEvent = {
      currentTarget: { matches: vi.fn(() => false) },
      preventDefault: vi.fn()
    }
    ;(closeTooltipTrigger?.props.onFocus as (event: typeof focusEvent) => void)(focusEvent)
    expect(focusEvent.preventDefault).toHaveBeenCalledOnce()
    ;(title?.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'New title' }
    })
    ;(description?.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: '' }
    })
    expect(onTitleDraftChange).toHaveBeenCalledWith('New title')
    expect(onDescriptionDraftChange).toHaveBeenCalledWith('')
    ;(form?.props.onSubmit as (event: unknown) => void)('submit-event')
    expect(onConfirmEdit).toHaveBeenCalledWith('submit-event')
  })

  it('allows an empty description but disables Save for a blank title', async () => {
    const { EditSessionDialog } = await import('./EditSessionDialog')
    const render = (titleDraft: string): ElementWithProps[] =>
      collectElements(
        EditSessionDialog({
          session: createSession(),
          titleDraft,
          descriptionDraft: '',
          onTitleDraftChange: vi.fn(),
          onDescriptionDraftChange: vi.fn(),
          onCancel: vi.fn(),
          onConfirmEdit: vi.fn()
        })
      )
    const saveButton = (elements: ElementWithProps[]): ElementWithProps | undefined =>
      elements.find((element) => getTextContent(element).trim() === 'Save')

    expect(saveButton(render('   '))?.props.disabled).toBe(true)
    expect(saveButton(render('Valid'))?.props.disabled).toBe(false)
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
    expect(getTextContent(tree)).toContain(
      'Messages and execution evidence attached to those Artifacts will remain available in Provenance.'
    )
    expect(getTextContent(tree)).toContain('Files in its working folder are not deleted.')
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

  it('keeps deletion open and disables duplicate or dismiss actions while deleting', async () => {
    const { DeleteSessionDialog } = await import('./DeleteSessionDialog')
    const onCancel = vi.fn()
    const tree = DeleteSessionDialog({
      session: createSession(),
      canDelete: true,
      isDeleting: true,
      onCancel,
      onConfirmDelete: vi.fn()
    })
    const elements = collectElements(tree)
    const root = elements[0]
    const content = elements.find((element) => element.props['aria-busy'] === true)
    const deletingButton = elements.find(
      (element) => getTextContent(element).trim() === 'Deleting…' && element.props.onClick
    )
    const closeButton = elements.find((element) => element.props['aria-label'] === 'Close')
    const cancelButton = elements.find(
      (element) => getTextContent(element).trim() === 'Cancel' && element.props.disabled === true
    )
    const status = elements.find((element) => element.props.role === 'status')

    ;(root.props.onOpenChange as (open: boolean) => void)(false)

    expect(onCancel).not.toHaveBeenCalled()
    expect(content).toBeDefined()
    expect(deletingButton?.props.disabled).toBe(true)
    expect(closeButton?.props.disabled).toBe(true)
    expect(cancelButton).toBeDefined()
    expect(getTextContent(status)).toBe('Deleting…')
  })

  it('renders safe accessible deletion errors with retry and cancel actions', async () => {
    const { DeleteSessionDialog } = await import('./DeleteSessionDialog')
    const onCancel = vi.fn()
    const onConfirmDelete = vi.fn()
    const tree = DeleteSessionDialog({
      session: createSession(),
      canDelete: true,
      error: 'persistence',
      onCancel,
      onConfirmDelete
    })
    const elements = collectElements(tree)
    const alert = elements.find((element) => element.props.role === 'alert')
    const retryButton = elements.find(
      (element) => getTextContent(element).trim() === 'Retry' && element.props.onClick
    )
    const cancelButton = elements.find(
      (element) => getTextContent(element).trim() === 'Cancel' && element.props.disabled !== true
    )

    expect(getTextContent(alert)).toBe(
      "The agent was stopped, but Open Science couldn't delete the saved Session. The Session, draft, and attachments were kept. Please try again."
    )
    expect(getTextContent(tree)).not.toContain('disk locked')
    ;(retryButton?.props.onClick as () => void)()
    expect(onConfirmDelete).toHaveBeenCalledOnce()
    expect(cancelButton).toBeDefined()

    const runtimeTree = DeleteSessionDialog({
      session: createSession(),
      canDelete: true,
      error: 'runtime',
      onCancel,
      onConfirmDelete
    })
    const runtimeAlert = collectElements(runtimeTree).find(
      (element) => element.props.role === 'alert'
    )
    expect(getTextContent(runtimeAlert)).toBe(
      "Open Science couldn't stop the agent for this Session. The Session was not deleted. Please try again."
    )
  })
})
