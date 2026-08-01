import { describe, expect, it } from 'vitest'

import type { Project } from '../../shared/projects'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  TaskRunner,
  type TaskPreviewResourcePort,
  type TaskProjectPort,
  type TaskRunnerDependencies,
  type TaskSessionPort
} from './task-runner'

const project: Project = {
  id: 'project-1',
  name: 'systematic-review',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: project.id,
  title: 'Review session',
  cwd: '/workspace/review',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 2
}

const createRunner = (overrides: Partial<TaskRunnerDependencies> = {}): TaskRunner =>
  new TaskRunner({
    projects: {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    },
    sessions: { list: async () => [], save: async () => undefined },
    previewResources: {
      acquire: async () => ({ id: 'resource-1', url: 'preview://resource-1', size: 0 }),
      release: async () => undefined
    },
    agent: {
      listAttachedSessionIds: async () => [],
      createSession: async () => ({ sessionId: 'session-created' }),
      resumeSession: async (request) => ({ sessionId: request.sessionId }),
      setPermissionProfile: async () => undefined,
      sendPrompt: async () => undefined
    },
    artifacts: {
      finalizeRun: async () => ({ ok: true, artifacts: [] })
    },
    runtimeEvents: { subscribe: () => () => undefined },
    createId: () => 'generated-id',
    now: () => 1,
    ...overrides
  })

describe('TaskRunner', () => {
  it('lists projects through its public interface', async () => {
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    }
    const runner = createRunner({ projects })

    await expect(runner.listProjects()).resolves.toEqual([project])
  })

  it('rejects an empty project name before creating a project', async () => {
    let created = false
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => {
        created = true
        return { ...project, ...request }
      }
    }
    const runner = createRunner({ projects })

    await expect(runner.createProject({ name: '   ' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Project name is required.'
    })
    expect(created).toBe(false)
  })

  it('lists session snapshots for a project name', async () => {
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    }
    const sessions: TaskSessionPort = {
      list: async () => [session],
      save: async () => undefined
    }
    const runner = createRunner({ projects, sessions })

    await expect(runner.listSessions(project.name)).resolves.toEqual([
      expect.objectContaining({ id: session.id, projectId: project.id, title: session.title })
    ])
  })

  it('returns a durable session snapshot and its artifacts', async () => {
    const artifactSession: PersistedChatSession = {
      ...session,
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'managed-file',
          path: '/artifacts/report.md',
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 12
        }
      ]
    }
    const runner = createRunner({
      sessions: { list: async () => [artifactSession], save: async () => undefined }
    })

    await expect(runner.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
      artifactCount: 1
    })
    await expect(runner.listArtifacts(session.id)).resolves.toEqual(artifactSession.artifacts)
  })

  it('acquires and releases a persisted artifact through the preview-resource port', async () => {
    const artifactSession: PersistedChatSession = {
      ...session,
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'managed-file',
          path: '/artifacts/report.md',
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 12
        }
      ]
    }
    const released: string[] = []
    const previewResources: TaskPreviewResourcePort = {
      acquire: async () => ({
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.md',
        size: 12,
        mimeType: 'text/markdown'
      }),
      release: async (resourceId) => {
        released.push(resourceId)
      }
    }
    const runner = createRunner({
      sessions: { list: async () => [artifactSession], save: async () => undefined },
      previewResources
    })

    await expect(runner.acquireArtifact('artifact-1')).resolves.toMatchObject({
      resourceId: 'resource-1',
      name: 'report.md',
      mimeType: 'text/markdown'
    })
    await runner.releaseArtifact('resource-1')
    expect(released).toEqual(['resource-1'])
  })
})
