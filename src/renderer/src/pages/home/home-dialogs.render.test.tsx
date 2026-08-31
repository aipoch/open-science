import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { AlertDialog } from 'radix-ui'
import { describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { expectDialogFormFieldClassName } from '@/test-utils/dialog-form'

// These tests call the components as plain functions, so there is no React context for a real hook.
// The stub resolves against the actual English catalog rather than echoing keys back: a renamed or
// deleted key surfaces here as a failed text assertion instead of silently passing.
vi.mock('react-i18next', () => createI18nTestStub())

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

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Protein folding',
  description: 'Protein folding notes',
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  isExample: false,
  ...overrides
})

describe('home dialogs shared chrome', () => {
  it('renders the project form with settings dialog chrome and an explicit close control', async () => {
    const { ProjectFormDialog } = await import('./ProjectFormDialog')
    const onCancel = vi.fn()

    const tree = ProjectFormDialog({
      open: true,
      title: 'New project',
      description: 'Create a project.',
      submitLabel: 'Create',
      nameDraft: '',
      descriptionDraft: '',
      agentContextDraft: '',
      isSubmitting: false,
      error: undefined,
      onNameChange: vi.fn(),
      onDescriptionChange: vi.fn(),
      onAgentContextChange: vi.fn(),
      onCancel,
      onConfirm: vi.fn()
    })

    expectSettingsDialogChrome(tree, 'w-[min(460px,calc(100vw-2rem))]', onCancel)
    expect(getTextContent(tree)).toContain(
      "Shown in the project list for your reference — not included in the agent's prompt."
    )
    const elements = collectElements(tree)
    const nameField = elements.find((element) => element.props.id === 'project-form-name')
    const descriptionField = elements.find((element) => element.type === 'textarea')
    const agentContextField = elements.find(
      (element) => element.props.id === 'project-form-agent-context'
    )
    const cancelButton = elements.find(
      (element) => getTextContent(element).trim() === 'Cancel' && element.props.onClick
    )

    expect(
      elements.find((element) => String(element.props.className ?? '').includes('space-y-4'))
    ).toBeDefined()
    ;['project-form-name', 'project-form-description', 'project-form-agent-context'].forEach(
      (htmlFor) =>
        expect(
          elements.find((element) => element.props.htmlFor === htmlFor)?.props.className
        ).toContain('block text-sm font-medium text-foreground mb-1')
    )
    ;['project-form-description-help', 'project-form-agent-context-help'].forEach((id) =>
      expect(elements.find((element) => element.props.id === id)?.props.className).toContain(
        'text-xs leading-relaxed text-foreground/90 mb-2'
      )
    )
    ;[
      elements.find((element) => element.props.id === 'project-form-name'),
      descriptionField,
      agentContextField
    ].forEach((field) => expectDialogFormFieldClassName(field?.props.className))
    expect(descriptionField?.props['aria-describedby']).toBe('project-form-description-help')
    expect(nameField?.props['aria-required']).toBe(true)
    expect(nameField?.props.maxLength).toBe(200)
    expect(descriptionField?.props.maxLength).toBe(1000)
    expect(descriptionField?.props.placeholder).toBe('Describe what this project is about…')
    expect(agentContextField?.props['aria-describedby']).toBe('project-form-agent-context-help')
    expect(cancelButton?.props.variant).toBe('ghost')
    expect(cancelButton?.props.className).toContain('cursor-pointer')
    expect(cancelButton?.props.className).toContain('hover:bg-bg-200')
    expect(cancelButton?.props.onClick).toBe(onCancel)
    expect(getTextContent(tree)).toContain('Agent Context')
    expect(getTextContent(tree)).toContain(
      'Injected into the system prompt of every agent session in this project, including resumed ones.'
    )
  })

  it('wires the Agent Context textarea value and change callback', async () => {
    const { ProjectFormDialog } = await import('./ProjectFormDialog')
    const onAgentContextChange = vi.fn()

    const tree = ProjectFormDialog({
      open: true,
      title: 'Project Settings',
      description: 'Update this project.',
      submitLabel: 'Save',
      nameDraft: 'Research',
      descriptionDraft: '',
      agentContextDraft: 'Always cite DOIs.',
      isSubmitting: false,
      error: undefined,
      onNameChange: vi.fn(),
      onDescriptionChange: vi.fn(),
      onAgentContextChange,
      onCancel: vi.fn(),
      onConfirm: vi.fn()
    })

    const field = collectElements(tree).find(
      (element) => element.props.id === 'project-form-agent-context'
    )
    expect(field?.props.value).toBe('Always cite DOIs.')
    expect(field?.props.maxLength).toBe(16000)
    expect(getTextContent(tree)).toContain(
      'Sent to the model provider with every session — do not include secrets.'
    )
    expect(field?.props.placeholder).toBe(
      'e.g. Always cite sources with DOIs. Prefer Python for analysis. Report p-values with effect sizes.'
    )
    ;(field?.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'Prefer R.' }
    })
    expect(onAgentContextChange).toHaveBeenCalledWith('Prefer R.')
  })

  it('renders the delete project confirmation with settings dialog chrome and primary cancel affordances', async () => {
    const { DeleteProjectDialog } = await import('./DeleteProjectDialog')
    const onCancel = vi.fn()
    const onConfirmDelete = vi.fn()

    const tree = DeleteProjectDialog({
      project: createProject(),
      sessionCount: 2,
      hasCompleteSessionCatalog: true,
      canDelete: true,
      isDeleting: false,
      error: undefined,
      onCancel,
      onConfirmDelete
    })
    const elements = collectElements(tree)
    const text = getTextContent(tree)
    const deleteButton = elements.find(
      (element) => getTextContent(element).trim() === 'Delete' && element.props.onClick
    )

    expectSettingsDialogChrome(tree, 'w-[min(440px,calc(100vw-2rem))]', onCancel, {
      interceptsOutsideClick: false
    })
    expect(deleteButton?.props.className).toContain('bg-danger-000')
    expect(elements.some((element) => element.type === AlertDialog.Action)).toBe(false)
    expect(text).toContain(
      'Generated artifacts and uploaded files stored by Open Science will also be deleted.'
    )
    expect(text).toContain('Deleting this project will stop its running tasks and notebooks.')
    expect(text).toContain("Files in the project's working folder are not deleted.")
    expect(text).toContain(
      'Retained managed Session workspaces remain available in Settings → Storage.'
    )
    expect(text).not.toContain('Generated artifacts remain on disk')
  })

  it('warns about unreadable conversations without showing an incomplete session count', async () => {
    const { DeleteProjectDialog } = await import('./DeleteProjectDialog')

    const tree = DeleteProjectDialog({
      project: createProject(),
      sessionCount: 1,
      hasCompleteSessionCatalog: false,
      canDelete: true,
      isDeleting: false,
      error: undefined,
      onCancel: vi.fn(),
      onConfirmDelete: vi.fn()
    })
    const text = getTextContent(tree)

    expect(text).toContain(
      'all of its saved conversations, including any that could not be loaded during recovery'
    )
    expect(text).not.toContain('its 1 session')
  })

  it('renders a durable deletion failure as an inline alert', async () => {
    const { DeleteProjectDialog } = await import('./DeleteProjectDialog')

    const tree = DeleteProjectDialog({
      project: createProject(),
      sessionCount: 0,
      hasCompleteSessionCatalog: true,
      canDelete: true,
      isDeleting: false,
      error: 'Project storage is unavailable.',
      onCancel: vi.fn(),
      onConfirmDelete: vi.fn()
    })
    const alert = collectElements(tree).find((element) => element.props.role === 'alert')

    expect(alert).toBeDefined()
    expect(getTextContent(alert)).toBe('Project storage is unavailable.')
  })

  it('locks every dismissal and confirmation control while deletion is pending', async () => {
    const { DeleteProjectDialog } = await import('./DeleteProjectDialog')

    const tree = DeleteProjectDialog({
      project: createProject(),
      sessionCount: 0,
      hasCompleteSessionCatalog: true,
      canDelete: true,
      isDeleting: true,
      error: undefined,
      onCancel: vi.fn(),
      onConfirmDelete: vi.fn()
    })
    const elements = collectElements(tree)
    const closeButton = elements.find((element) => element.props['aria-label'] === 'Close')
    const cancelButton = elements.find(
      (element) => getTextContent(element).trim() === 'Cancel' && element.props.disabled
    )
    const deleteButton = elements.find(
      (element) =>
        getTextContent(element).trim() === 'Deleting…' &&
        String(element.props.className).includes('bg-danger-000')
    )

    expect(closeButton?.props.disabled).toBe(true)
    expect(cancelButton?.props.variant).toBe('ghost')
    expect(cancelButton?.props.className).toContain('border-0')
    expect(cancelButton?.props.className).toContain('shadow-none')
    expect(cancelButton?.props.disabled).toBe(true)
    expect(deleteButton?.props.disabled).toBe(true)
  })
})
