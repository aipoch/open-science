// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { HomePage } from './HomePage'

vi.mock('@/components/GitHubStarBadge', () => ({ GitHubStarBadge: () => null }))
vi.mock('@/components/ThemeControls', () => ({ ThemePreferenceMenu: () => null }))
vi.mock('@/components/UpdateCapsule', () => ({ UpdateCapsule: () => null }))
vi.mock('./ProjectFormDialog', () => ({ ProjectFormDialog: () => null }))
vi.mock('./DeleteProjectDialog', () => ({
  DeleteProjectDialog: ({
    project,
    canDelete,
    hasCompleteSessionCatalog,
    onConfirmDelete
  }: {
    project: Project | undefined
    canDelete: boolean
    hasCompleteSessionCatalog: boolean
    onConfirmDelete: () => void
  }) => (
    <button
      type="button"
      data-testid="confirm-project-delete"
      data-can-delete={String(canDelete)}
      data-has-project={String(Boolean(project))}
      data-has-complete-session-catalog={String(hasCompleteSessionCatalog)}
      onClick={onConfirmDelete}
    >
      Confirm delete
    </button>
  )
}))
vi.mock('radix-ui', () => ({
  DropdownMenu: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>,
    Separator: () => null,
    Item: ({
      children,
      disabled,
      onSelect
    }: {
      children: ReactNode
      disabled?: boolean
      onSelect?: () => void
    }) => (
      <button type="button" disabled={disabled} onClick={onSelect}>
        {children}
      </button>
    )
  }
}))

const project: Project = {
  id: 'project-1',
  name: 'Protected project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

describe('HomePage persistence recovery', () => {
  let container: HTMLDivElement
  let root: Root
  let deleteProject: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    deleteProject = vi.fn().mockResolvedValue(undefined)
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true,
      deleteProject
    } as never)
    useSessionStore.setState(createInitialSessionState())
    useNavigationStore.setState({
      view: 'home',
      activeProjectId: undefined,
      userNavigationRevision: 0,
      explicitNavigationRevision: 0
    })
    useSettingsStore.setState(createInitialSettingsState())
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('disables project deletion while session persistence is recovering', async () => {
    await act(async () =>
      root.render(<HomePage canDeleteProjects={false} hasCompleteSessionCatalog={false} />)
    )

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )

    expect(deleteAction?.disabled).toBe(true)
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.dataset
        .canDelete
    ).toBe('false')
  })

  it('does not present partial project Session counts as authoritative', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      projectId: project.id,
      cwd: '/workspace/project-1',
      content: 'Recovered conversation'
    })

    await act(async () =>
      root.render(<HomePage canDeleteProjects hasCompleteSessionCatalog={false} />)
    )

    expect(container.textContent).toContain('Session count unavailable')
    expect(container.textContent).not.toContain('1 session')
  })

  it('guards confirmation when persistence becomes unavailable after the dialog opens', async () => {
    await act(async () => root.render(<HomePage canDeleteProjects hasCompleteSessionCatalog />))

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )
    await act(async () => deleteAction?.click())

    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-project-delete"]'
    )
    expect(confirm?.dataset.hasProject).toBe('true')

    await act(async () =>
      root.render(<HomePage canDeleteProjects={false} hasCompleteSessionCatalog={false} />)
    )
    expect(confirm?.dataset.canDelete).toBe('false')
    await act(async () => confirm?.click())

    expect(deleteProject).not.toHaveBeenCalled()
  })

  it('records explicit user takeover before starting Project deletion', async () => {
    await act(async () =>
      root.render(<HomePage canDeleteProjects hasCompleteSessionCatalog={false} />)
    )

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )
    await act(async () => deleteAction?.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.click()
    )

    expect(useNavigationStore.getState().userNavigationRevision).toBe(1)
    expect(deleteProject).toHaveBeenCalledWith(project.id)
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.dataset
        .hasCompleteSessionCatalog
    ).toBe('false')
  })
})
