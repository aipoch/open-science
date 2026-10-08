import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectFileItem } from '../../../../shared/project-files'

import { projectFileMentionTransfers } from './project-file-mention-transfer'

const file = (overrides: Partial<ProjectFileItem> = {}): ProjectFileItem => ({
  id: 'file-1',
  source: 'artifact',
  sourceFileId: 'artifact-1',
  sourceVersionId: 'version-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  name: 'report.md',
  path: '/workspace/report.md',
  size: 10,
  sortAtMs: 1,
  ...overrides
})

afterEach(() => projectFileMentionTransfers.cancel())

describe('projectFileMentionTransfers', () => {
  it('exposes the same live file through a one-use token', () => {
    const live = file()
    const unregister = projectFileMentionTransfers.register('source-1', {
      read: () => ({ projectId: live.projectId, file: live })
    })
    const token = projectFileMentionTransfers.begin('source-1')
    expect(token).toBeDefined()
    expect(projectFileMentionTransfers.read(token)).toEqual({
      projectId: 'project-1',
      file: live
    })
    expect(projectFileMentionTransfers.read('another-token')).toBeUndefined()
    unregister()
  })

  it('refuses to start from an unavailable source', () => {
    projectFileMentionTransfers.register('disabled', { read: () => undefined })
    expect(projectFileMentionTransfers.begin('disabled')).toBeUndefined()
    expect(projectFileMentionTransfers.begin('missing')).toBeUndefined()
  })

  it('drops the transfer when the source changed after the drag started', () => {
    let live = file()
    projectFileMentionTransfers.register('source-1', {
      read: () => ({ projectId: live.projectId, file: live })
    })
    const token = projectFileMentionTransfers.begin('source-1')
    live = file({ name: 'renamed.md' })
    expect(projectFileMentionTransfers.read(token)).toBeUndefined()
  })

  it('cancelling invalidates the pending token', () => {
    projectFileMentionTransfers.register('source-1', {
      read: () => ({ projectId: 'project-1', file: file() })
    })
    const token = projectFileMentionTransfers.begin('source-1')
    projectFileMentionTransfers.cancel()
    expect(projectFileMentionTransfers.read(token)).toBeUndefined()
  })
})
