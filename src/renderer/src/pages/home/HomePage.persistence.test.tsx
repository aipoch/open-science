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
vi.mock('@/components/NetworkStatusIndicator', () => ({ NetworkStatusIndicator: () => null }))
vi.mock('@/components/ThemeControls', () => ({ ThemePreferenceMenu: () => null }))
vi.mock('@/components/UpdateCapsule', () => ({ UpdateCapsule: () => null }))
vi.mock('./ProjectFormDialog', () => ({ ProjectFormDialog: () => null }))
vi.mock('./DeleteProjectDialog', () => ({
  DeleteProjectDialog: ({
    project,
    canDelete,
    hasCompleteSessionCatalog,
    isDeleting,
    error,
    onConfirmDelete
  }: {
    project: Project | undefined
    canDelete: boolean
    hasCompleteSessionCatalog: boolean
    isDeleting: boolean
    error: string | undefined
    onConfirmDelete: () => void
  }) => (
    <>
      <button
        type="button"
        data-testid="confirm-project-delete"
        data-can-delete={String(canDelete)}
        data-has-project={String(Boolean(project))}
        data-has-complete-session-catalog={String(hasCompleteSessionCatalog)}
        data-is-deleting={String(isDeleting)}
        disabled={isDeleting}
        onClick={onConfirmDelete}
      >
        Confirm delete
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  )
}))
vi.mock('radix-ui', () => ({
  Tooltip: {
    Provider: ({ children }: { children: ReactNode }) => <>{children}</>,
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>
  },
  DropdownMenu: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>,
    Separator: () => null,
    Item: ({
      children,
      disabled,
      title,
      onSelect
    }: {
      children: ReactNode
      disabled?: boolean
      title?: string
      onSelect?: () => void
    }) => (
      <button type="button" disabled={disabled} title={title} onClick={onSelect}>
        {children}
      </button>
    ),
    Group: ({ children }: { children: ReactNode }) => <>{children}</>,
    Label: ({ children }: { children: ReactNode }) => <>{children}</>,
    Sub: ({ children }: { children: ReactNode }) => <>{children}</>,
    SubContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SubTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
  },
  // The header's language picker is built on the Select primitive. This suite is about persistence
  // recovery, so the picker only has to mount — passthroughs keep it out of the way.
  Select: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Group: ({ children }: { children: ReactNode }) => <>{children}</>,
    Value: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
    Icon: ({ children }: { children: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>,
    Viewport: ({ children }: { children: ReactNode }) => <>{children}</>,
    Label: ({ children }: { children: ReactNode }) => <>{children}</>,
    Item: ({ children }: { children: ReactNode }) => <>{children}</>,
    ItemText: ({ children }: { children: ReactNode }) => <>{children}</>,
    ItemIndicator: ({ children }: { children: ReactNode }) => <>{children}</>,
    Separator: () => null,
    ScrollUpButton: () => null,
    ScrollDownButton: () => null
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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        projectFiles: {
          getOverview: vi.fn().mockResolvedValue({
            totalCount: 0,
            uploadCount: 0,
            artifactCount: 0,
            artifactGroupCount: 0,
            isIndexComplete: true
          }),
          onChanged: vi.fn(() => vi.fn())
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    deleteProject = vi.fn().mockResolvedValue({ status: 'deleted' })
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
      root.render(
        <HomePage
          canDeleteProjects={false}
          hasCompleteSessionCatalog={false}
          onOpenGlobalSearch={vi.fn()}
        />
      )
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
      root.render(
        <HomePage
          canDeleteProjects
          hasCompleteSessionCatalog={false}
          onOpenGlobalSearch={vi.fn()}
        />
      )
    )

    expect(container.textContent).toContain('Session count unavailable')
    expect(container.textContent).not.toContain('1 session')
  })

  it('directs unsupported Session versions to an app update instead of index repair', async () => {
    await act(async () =>
      root.render(
        <HomePage
          canDeleteProjects
          hasCompleteSessionCatalog={false}
          catalogRecovery={{ kind: 'unsupported-version', affectedFileCount: 1 }}
          onOpenGlobalSearch={vi.fn()}
        />
      )
    )

    const archive = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Archive'
    )
    expect(archive?.disabled).toBe(true)
    expect(archive?.title).toBe('')
    expect(container.textContent).toContain('Update Open Science before archiving this project.')
  })

  it('maps a raced incomplete-catalog archive rejection to index repair guidance', async () => {
    const updateProjectArchive = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'projects:update-archive': Error: Cannot archive a Project while its Session catalog is incomplete."
        )
      )
    useProjectStore.setState({ updateProjectArchive } as never)

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const archive = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Archive'
    )
    await act(async () => archive?.click())

    expect(updateProjectArchive).toHaveBeenCalledWith({
      id: project.id,
      archived: true,
      expectedArchivedAt: null
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Repair the project index before archiving.'
    )
    expect(container.textContent).not.toContain('Session catalog is incomplete')
  })

  it('guards confirmation when persistence becomes unavailable after the dialog opens', async () => {
    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )
    await act(async () => deleteAction?.click())

    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-project-delete"]'
    )
    expect(confirm?.dataset.hasProject).toBe('true')

    await act(async () =>
      root.render(
        <HomePage
          canDeleteProjects={false}
          hasCompleteSessionCatalog={false}
          onOpenGlobalSearch={vi.fn()}
        />
      )
    )
    expect(confirm?.dataset.canDelete).toBe('false')
    await act(async () => confirm?.click())

    expect(deleteProject).not.toHaveBeenCalled()
  })

  it('records explicit user takeover before starting Project deletion', async () => {
    await act(async () =>
      root.render(
        <HomePage
          canDeleteProjects
          hasCompleteSessionCatalog={false}
          onOpenGlobalSearch={vi.fn()}
        />
      )
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

  it('keeps the confirmation open, explains a durable deletion failure, and allows retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    deleteProject.mockRejectedValueOnce(
      new Error('ENOENT: no such file or directory, unlink /Users/private/OpenScience/project-1')
    )

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )
    await act(async () => deleteAction?.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.click()
    )

    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-project-delete"]'
    )
    expect(confirm?.dataset.hasProject).toBe('true')
    expect(confirm?.dataset.isDeleting).toBe('false')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not delete the project. Please try again.'
    )
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain('/Users/private')
    expect(warn).toHaveBeenCalledWith(
      'Project deletion failed',
      expect.objectContaining({
        message: 'ENOENT: no such file or directory, unlink /Users/private/OpenScience/project-1'
      })
    )
    expect(useProjectStore.getState().projects).toContainEqual(project)
    warn.mockRestore()

    deleteProject.mockResolvedValueOnce({ status: 'deleted' })
    await act(async () => confirm?.click())

    expect(deleteProject).toHaveBeenCalledTimes(2)
    expect(confirm?.dataset.hasProject).toBe('false')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('removes committed Project state and explains pending background cleanup', async () => {
    deleteProject.mockImplementationOnce(async () => {
      useProjectStore.setState({
        deletionCleanup: [
          {
            projectId: project.id,
            projectName: project.name,
            phase: 'running',
            failureCount: 0
          }
        ]
      } as never)
      return { status: 'cleanup-pending' }
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      projectId: project.id,
      cwd: '/workspace/project-1',
      content: 'Saved conversation'
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )
    await act(async () => deleteAction?.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.click()
    )

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      `Cleaning up ${project.name}…`
    )
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.dataset
        .hasProject
    ).toBe('false')

    await act(async () => useProjectStore.getState().removeProject(project.id))

    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
