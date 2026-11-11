// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PackageImportSelection } from './PackageImportSelection'
import { useProjectStore } from '@/stores/project-store'
import type { PackageOperationSnapshot } from '../../../shared/session-package'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
const project = {
  id: 'existing',
  name: 'Existing research',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}
const operation: PackageOperationSnapshot = {
  id: 'op',
  kind: 'import',
  state: 'awaiting-selection',
  progress: { phase: 'selecting' },
  importFilename: 'study.science'
}
beforeEach(() =>
  useProjectStore.setState({
    projects: [project],
    isLoaded: true,
    loadError: undefined,
    loadProjects: async () => undefined
  })
)
afterEach(cleanup)

it('prioritizes the current project after loading and preserves a manual choice on refresh', async () => {
  const current = { ...project, id: 'current', name: 'Current research' }
  const other = { ...project, id: 'other', name: 'Other research' }
  const projects = [project, current, other]
  useProjectStore.setState({ projects: [], isLoaded: false })
  const onContinue = vi.fn(async () => undefined)
  render(
    <PackageImportSelection
      operation={operation}
      currentProjectId={current.id}
      onCancel={vi.fn()}
      onContinue={onContinue}
    />
  )
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  act(() => useProjectStore.setState({ projects, isLoaded: true }))
  expect(screen.getAllByRole('radio').map((input) => (input as HTMLInputElement).value)).toEqual([
    'current',
    'existing',
    'other'
  ])
  expect((screen.getByRole('radio', { name: current.name }) as HTMLInputElement).checked).toBe(true)
  expect(projects.map(({ id }) => id)).toEqual(['existing', 'current', 'other'])
  fireEvent.click(screen.getByRole('radio', { name: project.name }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Existing' } })
  act(() => useProjectStore.setState({ projects: [...projects] }))
  expect(screen.queryByRole('radio', { name: current.name })).toBeNull()
  expect((screen.getByRole('radio', { name: project.name }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(onContinue).toHaveBeenCalledWith({ projectId: project.id }))
})

it.each([undefined, 'missing', 'archived'])(
  'leaves selection empty when the current project is unavailable (%s)',
  (currentProjectId) => {
    useProjectStore.setState({
      projects: [project, { ...project, id: 'archived', name: 'Archived research', archivedAt: 2 }]
    })
    render(
      <PackageImportSelection
        operation={operation}
        currentProjectId={currentProjectId}
        onCancel={vi.fn()}
        onContinue={vi.fn()}
      />
    )
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  }
)

it('uses an explicit creation action and returns without losing the selected destination', () => {
  render(<PackageImportSelection operation={operation} onCancel={vi.fn()} onContinue={vi.fn()} />)
  fireEvent.click(screen.getByRole('radio', { name: 'Existing research' }))
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Project name' }))
  expect(screen.queryByRole('radio')).toBeNull()
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(
    (screen.getByRole('radio', { name: 'Existing research' }) as HTMLInputElement).checked
  ).toBe(true)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New project' }))
})

it('retains the draft when continuing fails and prevents duplicate submissions', async () => {
  let finish: () => void = () => undefined
  const onContinue = vi
    .fn()
    .mockRejectedValueOnce(new Error('Cannot continue import'))
    .mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
  render(
    <PackageImportSelection operation={operation} onCancel={vi.fn()} onContinue={onContinue} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
    target: { value: 'New research' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Cannot continue import'))
  expect((screen.getByRole('textbox', { name: 'Project name' }) as HTMLInputElement).value).toBe(
    'New research'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  fireEvent.submit(screen.getByRole('textbox', { name: 'Project name' }).closest('form')!)
  expect(onContinue).toHaveBeenCalledTimes(2)
  await act(async () => finish())
})

it('keeps a new destination as a draft until the package has been validated and confirmed', async () => {
  const createProject = vi.fn()
  useProjectStore.setState({ createProject })
  const onContinue = vi.fn(async () => undefined)
  render(
    <PackageImportSelection operation={operation} onCancel={vi.fn()} onContinue={onContinue} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
    target: { value: '  Reproduction study  ' }
  })
  fireEvent.submit(screen.getByRole('textbox', { name: 'Project name' }).closest('form')!)
  await waitFor(() =>
    expect(onContinue).toHaveBeenCalledWith({ projectName: 'Reproduction study' })
  )
  expect(createProject).not.toHaveBeenCalled()
})
