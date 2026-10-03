// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { createArtifactVersionLocator } from '../../../../../shared/artifact-provenance'

import { projectFileSourceStatus } from './preview-source-status'

const item = (overrides: Partial<PreviewFileItem> = {}): PreviewFileItem => ({
  id: 'preview-1',
  type: 'file',
  title: 'notes.md',
  name: 'notes.md',
  path: '/project/notes.md',
  format: 'markdown',
  source: 'artifact',
  projectId: 'project-1',
  sessionId: 'session-1',
  selectedVersionId: 'version-7',
  ...overrides
})

describe('projectFileSourceStatus', () => {
  const locator = createArtifactVersionLocator({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-7'
  })

  it('reports pending while managed inspection is still resolving', () => {
    expect(
      projectFileSourceStatus(
        item({ managedFileId: 'artifact-1' }),
        undefined,
        undefined,
        true,
        'session-1'
      )
    ).toEqual({ ok: false, reason: 'version-pending' })
  })

  it('reports unresolved when a managed item carries no verifiable version', () => {
    expect(
      projectFileSourceStatus(
        item({ managedFileId: 'artifact-1', selectedVersionId: undefined }),
        undefined,
        undefined,
        false,
        'session-1'
      )
    ).toEqual({ ok: false, reason: 'version-unresolved' })
  })

  it('resolves a managed item whose locator version matches the scope session', () => {
    const status = projectFileSourceStatus(
      item({ managedFileId: 'artifact-1', path: locator, sessionId: 'session-1' }),
      undefined,
      undefined,
      false,
      'session-1'
    )
    expect(status).toEqual({
      ok: true,
      source: expect.objectContaining({ versionId: 'version-7', sessionId: 'session-1' })
    })
  })

  it('reports unresolved when the item session differs from the requesting scope', () => {
    expect(
      projectFileSourceStatus(
        item({ managedFileId: 'artifact-1', path: locator, sessionId: 'other-session' }),
        undefined,
        undefined,
        false,
        'session-1'
      )
    ).toMatchObject({ ok: false, reason: 'version-unresolved' })
  })

  it('preserves existing behavior when no scope session is known', () => {
    const status = projectFileSourceStatus(
      item({ managedFileId: 'artifact-1', path: locator, sessionId: 'other-session' })
    )
    expect(status.ok).toBe(true)
  })

  it('reports unresolved for pdf pages, which never use the project-file source', () => {
    expect(projectFileSourceStatus(item(), 2)).toEqual({
      ok: false,
      reason: 'version-unresolved'
    })
  })
})
