import { mapPackageReferences, sessionFileVersionIds } from './native-snapshot'
import { expect, it } from 'vitest'
import type { NotebookRunDocument } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  isProjectFolderWorkingProjection,
  portableProjectSession,
  projectFolderInputOmissions
} from './project-folder-portability'

it.each([
  '/home/research/project',
  String.raw`C:\Research\project`,
  String.raw`\\server\share\project`
])('removes legacy provider paths while preserving research payloads for %s', (folder) => {
  const session = {
    id: 'session',
    projectId: 'project',
    title: folder,
    cwd: folder,
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'message',
        role: 'user',
        content: folder,
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 2,
        parts: [{ type: 'text', text: folder }]
      }
    ]
  } as PersistedChatSession
  const result = portableProjectSession(session, '/managed')
  expect(result.cwd).toBe('')
  expect(result.title).toBe(folder)
  expect(result.messages[0].content).toBe(folder)
  expect(result.messages[0].parts).toEqual(session.messages[0].parts)
  expect(session.cwd).toBe(folder)
})

it('describes stat-only direct-mode inputs without inventing a checksum or a frozen snapshot', () => {
  const document = {
    runs: [{ projectFolderInputs: [{ relativePath: 'raw.csv', sizeBytes: 32, frozen: false }] }]
  } as unknown as NotebookRunDocument
  const omissions = projectFolderInputOmissions([document])
  expect(omissions).toContainEqual({
    kind: 'external',
    description: expect.stringContaining('raw.csv; checksum not captured; bytes: 32')
  })
  expect(JSON.stringify(omissions)).not.toContain('SHA-256: undefined')
})

it('skips private data projections in every lane without confusing other user filenames', () => {
  expect(isProjectFolderWorkingProjection('notebooks/project/session/data')).toBe(true)
  expect(
    isProjectFolderWorkingProjection('notebooks/project/session/frames/child/data/raw.csv')
  ).toBe(true)
  expect(
    isProjectFolderWorkingProjection('notebooks/project/session/attachments/database.json')
  ).toBe(false)
})

it('keeps folder mentions external during packaging and remaps only their Project identity on import', () => {
  const reference = {
    type: 'artifact',
    id: 'project-folder:project:nested/raw.csv',
    name: 'raw.csv',
    source: 'project-folder',
    projectId: 'project',
    path: 'nested/raw.csv'
  }
  const session = {
    projectId: 'project',
    id: 'session',
    cwd: '/private/folder',
    messages: [{ id: 'm', parts: [reference] }]
  } as unknown as PersistedChatSession
  expect(sessionFileVersionIds(session)).toEqual([])
  const portable = portableProjectSession(session, '/managed')
  expect(portable.messages[0].parts).toEqual([reference])
  expect(JSON.stringify(portable)).not.toContain('/private/folder')
  expect(
    mapPackageReferences(portable, { project: 'imported-project', session: 'imported-session' })
  ).toMatchObject({
    projectId: 'imported-project',
    messages: [
      {
        parts: [{ source: 'project-folder', projectId: 'imported-project', path: 'nested/raw.csv' }]
      }
    ]
  })
})
