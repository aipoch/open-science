import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />
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

  expect(overlay?.props.className).not.toContain('backdrop-blur')
  expect(panel?.props.className).toContain(expectedWidth)
  expect(panel?.props.className).toContain('text-foreground')
  expect(panel?.props.className).toContain('shadow-dialog')

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
      isSubmitting: false,
      error: undefined,
      onNameChange: vi.fn(),
      onDescriptionChange: vi.fn(),
      onCancel,
      onConfirm: vi.fn()
    })

    expectSettingsDialogChrome(tree, 'w-[min(460px,calc(100vw-2rem))]', onCancel)
  })

  it('renders the delete project confirmation with settings dialog chrome and primary cancel affordances', async () => {
    const { DeleteProjectDialog } = await import('./DeleteProjectDialog')
    const onCancel = vi.fn()
    const onConfirmDelete = vi.fn()

    const tree = DeleteProjectDialog({
      project: createProject(),
      sessionCount: 2,
      onCancel,
      onConfirmDelete
    })
    const elements = collectElements(tree)
    const deleteButton = elements.find(
      (element) => getTextContent(element).trim() === 'Delete' && element.props.onClick
    )

    expectSettingsDialogChrome(tree, 'w-[min(440px,calc(100vw-2rem))]', onCancel, {
      interceptsOutsideClick: false
    })
    expect(deleteButton?.props.className).toContain('bg-danger-000')
  })
})
