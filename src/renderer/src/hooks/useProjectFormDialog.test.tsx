// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../shared/projects'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'

import { useProjectFormDialog, type UseProjectFormDialogResult } from './useProjectFormDialog'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Research',
  description: 'A project',
  isExample: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const setProjectsApi = (api: Partial<Window['api']['projects']>): void => {
  ;(globalThis as unknown as { window: { api: { projects: unknown } } }).window = {
    api: { projects: api }
  } as never
}

// Minimal renderHook harness (the repo does not depend on @testing-library/react).
const renderHook = (): { current: () => UseProjectFormDialogResult; unmount: () => void } => {
  let latest: UseProjectFormDialogResult | undefined
  const container = document.createElement('div')
  const root = createRoot(container)

  const HookHarness = (): null => {
    latest = useProjectFormDialog()
    return null
  }

  act(() => {
    root.render(createElement(HookHarness))
  })

  return {
    current: () => {
      if (!latest) throw new Error('hook did not render')
      return latest
    },
    unmount: () =>
      act(() => {
        root.unmount()
      })
  }
}

const submitForm = (dialog: UseProjectFormDialogResult): void => {
  dialog.dialogProps.onConfirm({
    preventDefault: vi.fn()
  } as unknown as React.FormEvent<HTMLFormElement>)
}

const originalOpenProject = useNavigationStore.getState().openProject
const openProject = vi.fn()

beforeEach(() => {
  useProjectStore.setState(createInitialProjectState())
  openProject.mockReset()
  useNavigationStore.setState({ openProject })
})

afterEach(() => {
  useNavigationStore.setState({ openProject: originalOpenProject })
})

describe('useProjectFormDialog', () => {
  it('opens the create dialog with empty drafts and create labels', () => {
    const hook = renderHook()

    act(() => hook.current().openCreateDialog())

    expect(hook.current().dialogProps).toMatchObject({
      open: true,
      title: 'New project',
      description: 'Group related sessions under a project. You can rename it later.',
      submitLabel: 'Create project',
      nameDraft: '',
      descriptionDraft: '',
      agentContextDraft: '',
      isSubmitting: false,
      error: undefined
    })
    hook.unmount()
  })

  it('creates a trimmed project, closes the dialog, and navigates into it', async () => {
    const created = createProject({ id: 'created-1', name: 'Trimmed' })
    const create = vi.fn().mockResolvedValue(created)
    setProjectsApi({ create })
    const hook = renderHook()

    act(() => hook.current().openCreateDialog())
    act(() => hook.current().dialogProps.onNameChange('  Trimmed  '))
    act(() => hook.current().dialogProps.onDescriptionChange('  Notes  '))
    act(() => hook.current().dialogProps.onAgentContextChange('  Always cite DOIs.  '))
    await act(async () => submitForm(hook.current()))

    expect(create).toHaveBeenCalledWith({
      name: 'Trimmed',
      description: 'Notes',
      agentContext: 'Always cite DOIs.'
    })
    expect(hook.current().dialogProps.open).toBe(false)
    expect(openProject).toHaveBeenCalledWith('created-1', 'user')
    hook.unmount()
  })

  it('prefills drafts in edit mode and updates the project on confirm', async () => {
    const update = vi.fn().mockResolvedValue(createProject({ name: 'Renamed' }))
    setProjectsApi({ update })
    const hook = renderHook()

    act(() => hook.current().openEditDialog(createProject({ agentContext: 'Always cite DOIs.' })))

    expect(hook.current().dialogProps).toMatchObject({
      open: true,
      title: 'Project Settings',
      submitLabel: 'Save',
      nameDraft: 'Research',
      descriptionDraft: 'A project',
      agentContextDraft: 'Always cite DOIs.'
    })

    act(() => hook.current().dialogProps.onNameChange('Renamed'))
    await act(async () => submitForm(hook.current()))

    expect(update).toHaveBeenCalledWith({
      id: 'project-1',
      name: 'Renamed',
      description: 'A project',
      agentContext: 'Always cite DOIs.',
      expectedUpdatedAt: 1
    })
    expect(hook.current().dialogProps.open).toBe(false)
    expect(openProject).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('prefills an empty agent context draft for projects stored before the field existed', () => {
    const hook = renderHook()

    act(() => hook.current().openEditDialog(createProject()))

    expect(hook.current().dialogProps.agentContextDraft).toBe('')
    hook.unmount()
  })

  it('keeps the dialog open with an inline error when the mutation fails', async () => {
    setProjectsApi({ create: vi.fn().mockRejectedValue(new Error('database is locked')) })
    const hook = renderHook()

    act(() => hook.current().openCreateDialog())
    act(() => hook.current().dialogProps.onNameChange('Research'))
    await act(async () => submitForm(hook.current()))

    expect(hook.current().dialogProps.open).toBe(true)
    expect(hook.current().dialogProps.error).toBe('Could not save project. Please try again.')
    expect(hook.current().dialogProps.errorDetail).toBe('database is locked')
    expect(hook.current().dialogProps.isSubmitting).toBe(false)
    expect(openProject).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('explains how to recover from a stale Project edit', async () => {
    setProjectsApi({
      update: vi.fn().mockRejectedValue(new Error('Project changed elsewhere.'))
    })
    const hook = renderHook()

    act(() => hook.current().openEditDialog(createProject()))
    await act(async () => submitForm(hook.current()))

    expect(hook.current().dialogProps.open).toBe(true)
    expect(hook.current().dialogProps.error).toBe(
      'Project changed elsewhere. Reopen Project Settings and try again.'
    )
    expect(hook.current().dialogProps.isSubmitting).toBe(false)
    hook.unmount()
  })

  it('ignores cancel while a submission is in flight', async () => {
    let resolveCreate: ((project: Project) => void) | undefined
    setProjectsApi({
      create: vi.fn(() => new Promise<Project>((resolve) => (resolveCreate = resolve)))
    })
    const hook = renderHook()

    act(() => hook.current().openCreateDialog())
    act(() => hook.current().dialogProps.onNameChange('Research'))
    act(() => submitForm(hook.current()))

    expect(hook.current().dialogProps.isSubmitting).toBe(true)
    act(() => hook.current().dialogProps.onCancel())
    expect(hook.current().dialogProps.open).toBe(true)

    await act(async () => resolveCreate?.(createProject({ id: 'done' })))
    expect(hook.current().dialogProps.open).toBe(false)
    hook.unmount()
  })

  it('ignores reopening the dialog while a submission is in flight', async () => {
    let resolveCreate: ((project: Project) => void) | undefined
    setProjectsApi({
      create: vi.fn(() => new Promise<Project>((resolve) => (resolveCreate = resolve)))
    })
    const hook = renderHook()

    act(() => hook.current().openCreateDialog())
    act(() => hook.current().dialogProps.onNameChange('Research'))
    act(() => submitForm(hook.current()))

    expect(hook.current().dialogProps.isSubmitting).toBe(true)
    act(() => hook.current().openEditDialog(createProject({ name: 'Other' })))
    act(() => hook.current().openCreateDialog())

    // The in-flight create keeps its mode and drafts instead of being reset mid-submission.
    expect(hook.current().dialogProps).toMatchObject({
      open: true,
      title: 'New project',
      nameDraft: 'Research',
      isSubmitting: true
    })

    await act(async () => resolveCreate?.(createProject({ id: 'done' })))
    expect(hook.current().dialogProps.open).toBe(false)
    hook.unmount()
  })

  it('shows a fallback error when the mutation resolves without a project', async () => {
    setProjectsApi({ create: vi.fn().mockResolvedValue(undefined) })
    const hook = renderHook()

    act(() => hook.current().openCreateDialog())
    act(() => hook.current().dialogProps.onNameChange('Research'))
    await act(async () => submitForm(hook.current()))

    expect(hook.current().dialogProps.open).toBe(true)
    expect(hook.current().dialogProps.error).toBe('Could not save project. Please try again.')
    expect(hook.current().dialogProps.isSubmitting).toBe(false)
    expect(openProject).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('shows a fallback error when the update mutation resolves without a project', async () => {
    setProjectsApi({ update: vi.fn().mockResolvedValue(undefined) })
    const hook = renderHook()

    act(() => hook.current().openEditDialog(createProject()))
    await act(async () => submitForm(hook.current()))

    expect(hook.current().dialogProps.open).toBe(true)
    expect(hook.current().dialogProps.error).toBe('Could not save project. Please try again.')
    expect(hook.current().dialogProps.isSubmitting).toBe(false)
    expect(openProject).not.toHaveBeenCalled()
    hook.unmount()
  })
})
