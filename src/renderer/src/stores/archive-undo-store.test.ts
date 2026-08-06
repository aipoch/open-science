import { beforeEach, describe, expect, it } from 'vitest'

import { useArchiveUndoStore } from './archive-undo-store'

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
    useArchiveUndoStore.setState({ notices: [], restoringKey: undefined })
  })

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
