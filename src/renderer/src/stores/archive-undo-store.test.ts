import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from './project-store'
import { useSessionStore } from './session-store'
import { useArchiveUndoStore } from './archive-undo-store'

const updateProjectArchive = useProjectStore.getState().updateProjectArchive
const updateSessionArchive = useSessionStore.getState().updateSessionArchive

const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: 2
}

const session = {
  id: 'session-1',
  projectId: project.id,
  title: 'Session',
  cwd: '/workspace',
  status: 'idle' as const,
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  archivedAt: 2
}

describe('archive undo store deletion reconciliation', () => {
  beforeEach(() => {
    useProjectStore.setState({ updateProjectArchive })
    useSessionStore.setState({ updateSessionArchive })
    useArchiveUndoStore.setState({ notices: [], restoringKey: undefined })
  })

  afterEach(() => vi.restoreAllMocks())

  it.each(['project', 'session'] as const)(
    'keeps the %s Undo generation captured at archive time',
    async (kind) => {
      const command =
        kind === 'project'
          ? vi.spyOn(useProjectStore.getState(), 'updateProjectArchive').mockResolvedValue(project)
          : vi.spyOn(useSessionStore.getState(), 'updateSessionArchive').mockResolvedValue(session)
      const store = useArchiveUndoStore.getState()
      if (kind === 'project') store.enqueueProject({ ...project, archiveRevision: 1 })
      else store.enqueueSession({ ...session, revision: 1 })
      const oldKey = useArchiveUndoStore.getState().notices[0].key
      // A newer store snapshot must not silently replace the command's compared generation.
      if (kind === 'project')
        useProjectStore.setState({ projects: [{ ...project, archiveRevision: 3 }] })
      else useSessionStore.setState({ sessions: [{ ...session, revision: 3 }] })
      await store.undo(oldKey)
      expect(command).toHaveBeenCalledWith(
        kind === 'project'
          ? { id: project.id, archived: false, expectedArchiveRevision: 1 }
          : { projectId: project.id, sessionId: session.id, archived: false, expectedRevision: 1 }
      )
    }
  )

  it.each(['project', 'session'] as const)(
    'does not resolve an old %s Undo key to a same-millisecond archive',
    async (kind) => {
      const command =
        kind === 'project'
          ? vi.spyOn(useProjectStore.getState(), 'updateProjectArchive').mockResolvedValue(project)
          : vi.spyOn(useSessionStore.getState(), 'updateSessionArchive').mockResolvedValue(session)
      const store = useArchiveUndoStore.getState()
      if (kind === 'project') store.enqueueProject({ ...project, archiveRevision: 1 })
      else store.enqueueSession({ ...session, revision: 1 })
      const oldKey = useArchiveUndoStore.getState().notices[0].key
      if (kind === 'project') store.enqueueProject({ ...project, archiveRevision: 3 })
      else store.enqueueSession({ ...session, revision: 3 })
      expect(useArchiveUndoStore.getState().notices[0].key).not.toBe(oldKey)
      await store.undo(oldKey)
      expect(command).not.toHaveBeenCalled()
      if (kind === 'project') store.reconcileProject({ ...project, archiveRevision: 5 })
      else store.reconcileSession({ ...session, revision: 5 })
      expect(useArchiveUndoStore.getState().notices).toEqual([])
    }
  )

  it('dismisses the matching session notice', () => {
    useArchiveUndoStore.getState().enqueueSession(session)
    const key = useArchiveUndoStore.getState().notices[0]?.key
    useArchiveUndoStore.setState({ restoringKey: key })

    useArchiveUndoStore.getState().dismissSession(session.id)

    expect(useArchiveUndoStore.getState()).toMatchObject({
      notices: [],
      restoringKey: undefined
    })
  })

  it('dismisses the matching project notice', () => {
    useArchiveUndoStore.getState().enqueueProject(project)
    const key = useArchiveUndoStore.getState().notices[0]?.key
    useArchiveUndoStore.setState({ restoringKey: key })

    useArchiveUndoStore.getState().dismissProject(project.id)

    expect(useArchiveUndoStore.getState()).toMatchObject({
      notices: [],
      restoringKey: undefined
    })
  })
})
