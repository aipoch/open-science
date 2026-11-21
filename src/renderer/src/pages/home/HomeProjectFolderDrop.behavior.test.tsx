// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { isDesktopRenderer } from '@/lib/interface-scale'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { ProjectPackageDropZone } from '@/components/ProjectPackageDropZone'
import { ProjectFormDialog } from './ProjectFormDialog'

const inspectDroppedFolder = vi.fn()
const create = vi.fn()
const importPackage = vi.fn()
const Harness = (): React.JSX.Element => {
  const form = useProjectFormDialog()
  return (
    <ProjectPackageDropZone
      data-testid="home"
      canImport
      onFolder={isDesktopRenderer() ? form.openCreateDialogForFolder : undefined}
    >
      <button onClick={form.openCreateDialog}>New fixture</button>
      <ProjectFormDialog {...form.dialogProps} />
    </ProjectPackageDropZone>
  )
}
const transfer = (
  names = ['cohort-study'],
  isDirectory = true
): { types: string[]; files: File[]; items: object[] } => {
  const files = names.map((name) => new File([], name))
  return {
    types: ['Files'],
    files,
    items: files.map((file) => ({
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory }),
      getAsFile: () => file
    }))
  }
}

beforeEach(() => {
  useProjectStore.setState(createInitialProjectState())
  inspectDroppedFolder.mockReset().mockResolvedValue({ ok: true, path: '/Research/cohort-study' })
  create.mockReset().mockResolvedValue({
    id: 'project-1',
    name: 'cohort-study',
    description: '',
    isExample: false,
    createdAt: 1,
    updatedAt: 1
  })
  importPackage.mockReset().mockResolvedValue(null)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      platform: 'darwin',
      projects: { inspectDroppedFolder, create },
      sessions: { importPackage }
    }
  })
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-open-science-web-events')
})

describe('Home folder drop', () => {
  it('opens the shared dialog with the folder name and validated path, then waits for creation', async () => {
    render(<Harness />)
    const target = screen.getByTestId('home')
    const dataTransfer = transfer()
    fireEvent.dragEnter(target, { dataTransfer })
    expect(
      screen.getByText('Drop a folder to create a project, or a .science file to import')
    ).not.toBeNull()
    await act(async () => fireEvent.drop(target, { dataTransfer }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('cohort-study')
    expect(
      (screen.getByRole('radio', { name: 'A folder on this computer' }) as HTMLInputElement).checked
    ).toBe(true)
    expect(screen.getByText('/Research/cohort-study')).not.toBeNull()
    expect(inspectDroppedFolder).toHaveBeenCalledExactlyOnceWith(dataTransfer.files[0])
    expect(create).not.toHaveBeenCalled()
    expect(importPackage).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create project' })))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'cohort-study', rootPath: '/Research/cohort-study' })
    )
  })

  it('shows the same collapsed conflict as a picker selection and keeps creation disabled', async () => {
    inspectDroppedFolder.mockResolvedValue({
      ok: false,
      kind: 'conflict',
      path: '/Research/cohort-study',
      diagnostics: 'Project: Other study\nFolder: /Research/cohort-study'
    })
    render(<Harness />)
    await act(async () => fireEvent.drop(screen.getByTestId('home'), { dataTransfer: transfer() }))
    expect(screen.getByText('/Research/cohort-study')).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Project folder is already in use')
    expect(document.querySelector('details')?.open).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('ignores non-folder files without creating a project or inspecting a host path', async () => {
    render(<Harness />)
    await act(async () =>
      fireEvent.drop(screen.getByTestId('home'), { dataTransfer: transfer(['raw.csv'], false) })
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(inspectDroppedFolder).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects multiple folders without opening a creation dialog', () => {
    render(<Harness />)
    fireEvent.drop(screen.getByTestId('home'), { dataTransfer: transfer(['first', 'second']) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(inspectDroppedFolder).not.toHaveBeenCalled()
  })

  it('keeps the existing .science package drop behavior', async () => {
    render(<Harness />)
    await act(async () =>
      fireEvent.drop(screen.getByTestId('home'), {
        dataTransfer: transfer(['research.science'], false)
      })
    )
    expect(importPackage).toHaveBeenCalledOnce()
    expect(inspectDroppedFolder).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('does not expose host folder drops in remote browsers', () => {
    document.documentElement.setAttribute('data-open-science-web-events', 'true')
    render(<Harness />)
    fireEvent.drop(screen.getByTestId('home'), { dataTransfer: transfer() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(inspectDroppedFolder).not.toHaveBeenCalled()
  })
})
