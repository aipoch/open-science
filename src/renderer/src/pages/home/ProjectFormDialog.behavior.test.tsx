// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { ProjectFormDialog } from './ProjectFormDialog'

const project: Project = {
  id: 'project-1',
  name: 'Research',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const Harness = (): React.JSX.Element => {
  const form = useProjectFormDialog()
  return (
    <>
      <button onClick={form.openCreateDialog}>Create fixture</button>
      <button onClick={() => form.openEditDialog(project)}>Edit fixture</button>
      <ProjectFormDialog {...form.dialogProps} />
    </>
  )
}

beforeEach(() => useProjectStore.setState(createInitialProjectState()))
afterEach(cleanup)

describe('project form public submission behavior', () => {
  it.each(['create', 'edit'] as const)(
    'exposes pending %s and disables unavailable exits',
    async (mode) => {
      let reject!: (error: Error) => void
      const request = vi.fn(
        () =>
          new Promise<Project>((_resolve, rejectPromise) => {
            reject = rejectPromise
          })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { projects: { create: request, update: request } }
      })
      render(<Harness />)
      fireEvent.click(screen.getByText(mode === 'create' ? 'Create fixture' : 'Edit fixture'))
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Research' } })
      const submit = screen.getByRole('button', {
        name: mode === 'create' ? 'Create project' : 'Save'
      }) as HTMLButtonElement
      fireEvent.click(submit)
      expect(request).toHaveBeenCalledOnce()
      try {
        expect
          .soft((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled)
          .toBe(true)
        expect
          .soft((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled)
          .toBe(true)
        expect.soft(submit.closest('form')?.getAttribute('aria-busy')).toBe('true')
        expect.soft(submit.textContent).toBe(mode === 'create' ? 'Creating…' : 'Saving…')
        expect.soft(submit.querySelector('svg')).not.toBeNull()
      } finally {
        await act(async () => reject(new Error('database is locked')))
      }
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
        false
      )
      expect(screen.getByLabelText('Name').getAttribute('value')).toBe('Research')
    }
  )

  it('keeps a failed create actionable and puts raw errors in collapsed diagnostics', async () => {
    const raw = "Error invoking remote method 'projects:create': SQLITE_BUSY: database is locked"
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { projects: { create: vi.fn().mockRejectedValue(new Error(raw)) } }
    })
    render(<Harness />)
    fireEvent.click(screen.getByText('Create fixture'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Research' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create project' })))
    const alert = screen.getByRole('alert')
    expect.soft(alert.textContent).toMatch(/Could not.*project.*try again/i)
    expect.soft(alert.textContent).not.toContain('SQLITE_BUSY')
    const detail = screen.getByText(raw).closest('details')
    expect.soft(detail).not.toBeNull()
    expect.soft(detail?.open).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })
})
