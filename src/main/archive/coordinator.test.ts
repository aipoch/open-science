import { describe, expect, it, vi } from 'vitest'

import { ArchiveCoordinator } from './coordinator'

const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 2
}

const session = {
  id: 'session-1',
  projectId: project.id,
  title: 'Session',
  cwd: '/workspace',
  status: 'idle' as const,
  messages: [],
  createdAt: 1,
  updatedAt: 2
}

describe('ArchiveCoordinator', () => {
  it('archives a project only after the complete idle child catalog is checked', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn().mockResolvedValue({ ...project, archivedAt: 50 })
    }
    const sessions = {
      assertProjectArchivable: vi.fn().mockResolvedValue([session.id]),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, { isSessionBusy: vi.fn() })
    const markRead = vi.fn().mockResolvedValue(undefined)
    coordinator.setMarkReadSessions(markRead)

    await expect(
      coordinator.updateProjectArchive({ id: project.id, archived: true, expectedArchivedAt: null })
    ).resolves.toMatchObject({ archivedAt: 50 })

    expect(sessions.assertProjectArchivable).toHaveBeenCalledWith(project.id, expect.any(Function))
    expect(projects.updateArchive).toHaveBeenCalledWith(
      { id: project.id, archived: true, expectedArchivedAt: null },
      expect.any(Number)
    )
    expect(markRead).toHaveBeenCalledWith([session.id])
  })

  it('rejects an archive request whose compare-and-set value is stale', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue({ ...project, archivedAt: 40 }),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, { isSessionBusy: vi.fn() })

    await expect(
      coordinator.updateProjectArchive({ id: project.id, archived: false, expectedArchivedAt: 39 })
    ).rejects.toThrow('Project archive state changed elsewhere.')

    expect(projects.updateArchive).not.toHaveBeenCalled()
  })

  it('does not restore a session while its project remains archived', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue({ ...project, archivedAt: 40 }),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, { isSessionBusy: vi.fn() })

    await expect(
      coordinator.updateSessionArchive({
        projectId: project.id,
        sessionId: session.id,
        archived: false,
        expectedArchivedAt: 40
      })
    ).rejects.toThrow('Restore this archived Project before continuing.')

    expect(sessions.assertSessionAvailable).not.toHaveBeenCalled()
  })

  it('rejects a known session addressed through another project', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn().mockResolvedValue(project.id)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, { isSessionBusy: vi.fn() })

    await expect(coordinator.assertSessionAvailable('other-project', session.id)).rejects.toThrow(
      'Session does not belong to the requested Project.'
    )

    expect(sessions.assertSessionAvailable).not.toHaveBeenCalled()
  })
})
