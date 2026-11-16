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
const startFolder = (): void => {
  fireEvent.click(screen.getByText('New fixture'))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Research' } })
  fireEvent.click(screen.getByRole('radio', { name: 'A folder on this computer' }))
}
const submit = (): HTMLButtonElement => screen.getByRole('button', { name: 'Create project' })

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
    expect(
      (screen.getByRole('radio', { name: 'Managed by Open Science' }) as HTMLInputElement).checked
    ).toBe(true)
    expect(screen.queryByRole('button', { name: 'Choose…' })).toBeNull()
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

  it('waits for authoritative folder validation and saves the canonical path', async () => {
    const validation = deferred<ProjectFolderValidation>()
    validateFolder.mockReturnValue(validation.promise)
    render(<Harness />)
    startFolder()
    expect(submit().disabled).toBe(true)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose…' })))
    expect(validateFolder).toHaveBeenCalledWith({ path: '/Research/cohort-study' })
    expect(submit().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Checking…' })).not.toBeNull()
    await act(async () => validation.resolve({ ok: true, path: '/canonical/cohort-study' }))
    expect(submit().disabled).toBe(false)
    await act(async () => fireEvent.click(submit()))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: '/canonical/cohort-study' })
    )
  })

  it('blocks conflicts and keeps project names and paths in closed details', async () => {
    const diagnostics =
      'Project: Cohort follow-up\nFolder: /Research/shared-study\nArchive the other project first.'
    validateFolder.mockResolvedValue({ ok: false, kind: 'conflict', diagnostics })
    render(<Harness />)
    startFolder()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose…' })))
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
    fireEvent.click(screen.getByRole('radio', { name: 'Managed by Open Science' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(submit().disabled).toBe(false)
  })

  it('allows a validated location with nonblocking storage warnings', async () => {
    validateFolder.mockResolvedValue({
      ok: true,
      path: '/Research/cohort-study',
      warnings: ['cloud-synced', 'removable', 'network']
    })
    render(<Harness />)
    startFolder()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose…' })))
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
    startFolder()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose…' })))
    await act(async () => fireEvent.click(submit()))
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Research')
    expect(screen.getByRole('alert').textContent).toBe('Project folder is already in use')
    expect(submit().disabled).toBe(true)
  })

  it('ignores a late folder picker after changing storage or closing the dialog', async () => {
    const picker = deferred<string | null>()
    pickDirectory.mockReturnValue(picker.promise)
    render(<Harness />)
    startFolder()
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Managed by Open Science' }))
    await act(async () => picker.resolve('/late/folder'))
    expect(validateFolder).not.toHaveBeenCalled()
    expect(screen.queryByText('/late/folder')).toBeNull()
    expect(submit().disabled).toBe(false)
  })

  it('ignores late validation after discard and reopening', async () => {
    const validation = deferred<ProjectFolderValidation>()
    validateFolder.mockReturnValue(validation.promise)
    render(<Harness />)
    startFolder()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose…' })))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByText('New fixture'))
    await act(async () => validation.resolve({ ok: true, path: '/late/folder' }))
    expect(screen.queryByText('/late/folder')).toBeNull()
    expect(
      (screen.getByRole('radio', { name: 'Managed by Open Science' }) as HTMLInputElement).checked
    ).toBe(true)
  })

  it('keeps host folder selection unavailable in remote and local web browsers', () => {
    document.documentElement.setAttribute('data-open-science-web-events', 'true')
    render(<Harness />)
    fireEvent.click(screen.getByText('New fixture'))
    const choice = screen.getByRole('radio', {
      name: /A folder on this computer/
    }) as HTMLInputElement
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
    expect(screen.queryByRole('button', { name: 'Choose…' })).toBeNull()
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
