// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import type { LiteratureProject, LiteratureProjectCreation } from '../renderer-host'
import { LiteratureScopeProjectDialog } from './LiteratureScopeProjectDialog'

const openCreateDialog = vi.fn()
let creationOptions: { onCreated?: (project: LiteratureProject) => void } | undefined
const { render } = createLiteratureTestRenderer({
  useProjectFormDialog: (options) => {
    creationOptions = options
    return { openCreateDialog, isOpen: false, dialog: null } satisfies LiteratureProjectCreation
  }
})
const project: LiteratureProject = {
  id: 'project-1',
  name: 'Evidence project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}
const collection = { id: 'collection-1', name: 'Evidence collection' }
const onClose = vi.fn()
const onSelectProject = vi.fn(() => true)

beforeEach(() => {
  openCreateDialog.mockReset()
  onClose.mockReset()
  onSelectProject.mockReset().mockReturnValue(true)
})
afterEach(cleanup)

it('direct composer destination selection never asks for a second question and closes only after accepted navigation', () => {
  onSelectProject.mockReturnValueOnce(false)
  render(
    <LiteratureScopeProjectDialog
      collection={collection}
      projects={[project]}
      projectsLoaded
      onClose={onClose}
      onSelectProject={onSelectProject}
    />
  )
  expect(screen.queryByLabelText('Question')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByText(collection.name, { exact: false })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: project.name }))
  expect(onSelectProject).toHaveBeenLastCalledWith(project.id)
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: project.name }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('direct composer destination selection reuses project creation when no projects exist', () => {
  render(
    <LiteratureScopeProjectDialog
      collection={collection}
      projects={[]}
      projectsLoaded
      onClose={onClose}
      onSelectProject={onSelectProject}
    />
  )
  expect(screen.getByText('No active projects')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  expect(openCreateDialog).toHaveBeenCalledOnce()
  expect(onSelectProject).not.toHaveBeenCalled()
  act(() => creationOptions?.onCreated?.(project))
  expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(project.id)
  expect(onClose).toHaveBeenCalledOnce()
})

it('direct composer destination selection cancels without navigating and ignores project creation after leaving', () => {
  const view = render(
    <LiteratureScopeProjectDialog
      collection={collection}
      projects={[]}
      projectsLoaded
      onClose={onClose}
      onSelectProject={onSelectProject}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(onSelectProject).not.toHaveBeenCalled()
  view.unmount()
  act(() => creationOptions?.onCreated?.(project))
  expect(onSelectProject).not.toHaveBeenCalled()
})
