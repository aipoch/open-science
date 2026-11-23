// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import type { Project } from '../../../../shared/projects'
import type { ProjectFolderValidation } from '@/lib/project-folder'
import { ProjectFormDialog } from './ProjectFormDialog'
import { DeleteProjectDialog } from './DeleteProjectDialog'

const project: Project = {
  id: 'research',
  name: 'Research',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}
const create = vi.fn()
const update = vi.fn()
const pickDirectory = vi.fn()
const validateFolder = vi.fn()
const reveal = vi.fn()
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve: (value) => resolve(value)
  }
}
const Harness = ({ existing = project }: { existing?: Project }): React.JSX.Element => {
  const form = useProjectFormDialog()
  return (
    <>
      <button onClick={form.openCreateDialog}>New fixture</button>
      <button onClick={() => form.openEditDialog(existing)}>Edit fixture</button>
      <ProjectFormDialog {...form.dialogProps} />
    </>
  )
}
const startCreate = (): void => {
  fireEvent.click(screen.getByText('New fixture'))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Research' } })
}
const submit = (): HTMLButtonElement => screen.getByRole('button', { name: 'Create project' })
const choose = (): HTMLButtonElement => screen.getByRole('button', { name: 'Choose folder…' })

beforeEach(() => {
  useProjectStore.setState(createInitialProjectState())
  create.mockReset().mockResolvedValue(project)
  update.mockReset().mockResolvedValue(project)
  pickDirectory.mockReset().mockResolvedValue('/Research/cohort-study')
  validateFolder.mockReset().mockResolvedValue({ ok: true, path: '/Research/cohort-study' })
  reveal.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      platform: 'darwin',
      projects: { create, update, validateFolder },
      storage: { pickDirectory },
      localFs: { reveal }
    }
  })
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-open-science-web-events')
})

describe('Project folder creation and settings', () => {
  it('keeps managed creation as the default and omits folder binding', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('New fixture'))
    expect(screen.getByText('Default data location')).not.toBeNull()
    expect(choose().disabled).toBe(false)
    expect(screen.queryByRole('radio')).toBeNull()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Research' } })
    await act(async () => fireEvent.click(submit()))
    expect(create).toHaveBeenCalledWith({
      name: 'Research',
      description: '',
      agentContext: '',
      optimizationPrompt: ''
    })
    expect(validateFolder).not.toHaveBeenCalled()
  })

  it('uses the selected folder name and saves the validated canonical path', async () => {
    const validation = deferred<ProjectFolderValidation>()
    pickDirectory.mockResolvedValueOnce('/Research/Selected cohort/')
    validateFolder.mockReturnValue(validation.promise)
    render(<Harness />)
    fireEvent.click(screen.getByText('New fixture'))
    await act(async () => fireEvent.click(choose()))
    expect(pickDirectory).toHaveBeenCalledOnce()
    expect(validateFolder).toHaveBeenCalledWith({ path: '/Research/Selected cohort/' })
    expect(submit().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Checking…' })).not.toBeNull()
    await act(async () => validation.resolve({ ok: true, path: '/canonical/cohort-study' }))
    expect(screen.getByDisplayValue('Selected cohort')).not.toBeNull()
    expect(submit().disabled).toBe(false)
    await act(async () => fireEvent.click(submit()))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Selected cohort', rootPath: '/canonical/cohort-study' })
    )
  })

  it('updates the suggested name on Windows until the user edits it', async () => {
    Object.defineProperty(window.api, 'platform', { value: 'win32' })
    pickDirectory
      .mockResolvedValueOnce('C:\\Research\\Cohort one\\')
      .mockResolvedValueOnce('C:\\Research\\Cohort two')
      .mockResolvedValueOnce('C:\\Research\\Cohort three')
    render(<Harness />)
    fireEvent.click(screen.getByText('New fixture'))
    await act(async () => fireEvent.click(choose()))
    expect(screen.getByDisplayValue('Cohort one')).not.toBeNull()

    const changeFolder = (): HTMLElement => screen.getByRole('button', { name: 'Change folder…' })
    await act(async () => fireEvent.click(changeFolder()))
    expect(screen.getByDisplayValue('Cohort two')).not.toBeNull()

    const validation = deferred<ProjectFolderValidation>()
    validateFolder.mockReturnValueOnce(validation.promise)
    await act(async () => fireEvent.click(changeFolder()))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My study' } })
    await act(async () => validation.resolve({ ok: true, path: 'C:\\Research\\Cohort three' }))
    expect(screen.getByDisplayValue('My study')).not.toBeNull()
  })

  it('blocks conflicts and keeps project names and paths in closed details', async () => {
    const diagnostics =
      'Project: Cohort follow-up\nFolder: /Research/shared-study\nArchive the other project first.'
    validateFolder.mockResolvedValue({ ok: false, kind: 'conflict', diagnostics })
    render(<Harness />)
    startCreate()
    await act(async () => fireEvent.click(choose()))
    expect(screen.getByRole('alert').textContent).toBe('Project folder is already in use')
    expect(
      screen
        .getByText(
          (_, element) => element?.tagName === 'PRE' && element.textContent === diagnostics
        )
        .closest('details')?.open
    ).toBe(false)
    expect(submit().disabled).toBe(true)
    expect(create).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use app storage' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(choose())
    expect(submit().disabled).toBe(false)
  })

  it('allows a validated location with nonblocking storage warnings', async () => {
    validateFolder.mockResolvedValue({
      ok: true,
      path: '/Research/cohort-study',
      warnings: ['cloud-synced', 'removable', 'network']
    })
    render(<Harness />)
    startCreate()
    await act(async () => fireEvent.click(choose()))
    expect(screen.getByText('Cloud-synced folder')).not.toBeNull()
    expect(screen.getByText('Removable drive')).not.toBeNull()
    expect(screen.getByText('Network location')).not.toBeNull()
    expect(submit().disabled).toBe(false)
  })

  it('reports a create-time overlap race without closing or discarding drafts', async () => {
    create.mockRejectedValue({
      code: 'project-folder-conflict',
      message: 'Project: competing project\nPath: /Research/cohort-study'
    })
    render(<Harness />)
    startCreate()
    await act(async () => fireEvent.click(choose()))
    await act(async () => fireEvent.click(submit()))
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Research')
    expect(screen.getByRole('alert').textContent).toBe('Project folder is already in use')
    expect(submit().disabled).toBe(true)
  })

  it('preserves the current storage when cancelling the initial picker or a replacement', async () => {
    pickDirectory.mockResolvedValueOnce(null)
    render(<Harness />)
    startCreate()
    await act(async () => fireEvent.click(choose()))
    expect(screen.getByText('Default data location')).not.toBeNull()
    expect(validateFolder).not.toHaveBeenCalled()
    expect(submit().disabled).toBe(false)

    await act(async () => fireEvent.click(choose()))
    pickDirectory.mockResolvedValueOnce(null)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Change folder…' })))
    expect(screen.getByText('/Research/cohort-study')).not.toBeNull()
    expect(validateFolder).toHaveBeenCalledOnce()
    expect(submit().disabled).toBe(false)
  })

  it('ignores a late replacement picker after returning to app storage', async () => {
    const picker = deferred<string | null>()
    render(<Harness />)
    startCreate()
    await act(async () => fireEvent.click(choose()))
    pickDirectory.mockReturnValueOnce(picker.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Change folder…' }))
    expect(submit().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Use app storage' }))
    await act(async () => picker.resolve('/late/folder'))
    expect(validateFolder).toHaveBeenCalledOnce()
    expect(screen.queryByText('/late/folder')).toBeNull()
    expect(submit().disabled).toBe(false)
  })

  it('ignores late validation after discard and reopening', async () => {
    const validation = deferred<ProjectFolderValidation>()
    validateFolder.mockReturnValue(validation.promise)
    render(<Harness />)
    startCreate()
    await act(async () => fireEvent.click(choose()))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByText('New fixture'))
    await act(async () => validation.resolve({ ok: true, path: '/late/folder' }))
    expect(screen.queryByText('/late/folder')).toBeNull()
    expect(screen.getByText('Default data location')).not.toBeNull()
  })

  it('keeps host folder selection unavailable in remote and local web browsers', () => {
    document.documentElement.setAttribute('data-open-science-web-events', 'true')
    render(<Harness />)
    fireEvent.click(screen.getByText('New fixture'))
    const choice = choose()
    expect(choice.disabled).toBe(true)
    expect(screen.getByText('Available in the desktop app')).not.toBeNull()
    fireEvent.click(choice)
    expect(pickDirectory).not.toHaveBeenCalled()
  })

  it('shows a bound folder read-only in settings and preserves it when saving', async () => {
    render(<Harness existing={{ ...project, rootPath: '/Research/cohort-study' }} />)
    fireEvent.click(screen.getByText('Edit fixture'))
    expect(screen.getByText('/Research/cohort-study')).not.toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('button', { name: /^(Choose|Change) folder…$/ })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' })))
    expect(reveal).toHaveBeenCalledWith('/Research/cohort-study')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
    expect(update).toHaveBeenCalledWith({
      id: project.id,
      name: project.name,
      description: '',
      agentContext: '',
      optimizationPrompt: '',
      expectedUpdatedAt: 1
    })
  })

  it('explains deletion preserves the bound folder and its files', () => {
    render(
      <DeleteProjectDialog
        project={{ ...project, rootPath: '/Research/cohort-study' }}
        sessionCount={0}
        hasCompleteSessionCatalog
        canDelete
        isDeleting={false}
        error={undefined}
        onCancel={vi.fn()}
        onConfirmDelete={vi.fn()}
      />
    )
    expect(
      screen.getByText('Your project folder and its files will not be deleted.')
    ).not.toBeNull()
    expect(screen.getByText('/Research/cohort-study')).not.toBeNull()
  })
})
