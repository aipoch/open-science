import { describe, expect, it } from 'vitest'
import type { ChatSession, ToolActivity } from '@/stores/session-store-contract'
import { recordedWorkingFiles, workingFilesForMessage } from './message-working-files'
import { resolveMessageArtifactReference } from './session-message-artifact-reference'

const tool = (changes: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'tool',
  kind: 'tool',
  title: 'Edit',
  providerToolName: 'edit',
  toolKind: 'edit',
  status: 'completed',
  sortIndex: 1,
  eventIds: [],
  createdAt: 2,
  updatedAt: 2,
  ...changes
})

describe('recorded reply working files', () => {
  it('resolves #1167 bare plot.png from the recorded Notebook data path without publishing', () => {
    const files = recordedWorkingFiles(
      [
        tool({
          providerToolName: 'notebook_execute',
          toolKind: 'execute',
          rawOutput: { workingFiles: [{ relativePath: 'data/plot.png' }] }
        })
      ],
      '/workspace',
      '/notebooks/session'
    )
    expect(resolveMessageArtifactReference('plot.png', files)?.path).toBe(
      '/notebooks/session/data/plot.png'
    )
    expect(resolveMessageArtifactReference('data/plot.png', files)).toBe(files[0])
    expect(files[0].versionId).toBeUndefined()
  })

  it('uses ordinary editor locations on Windows and refuses ambiguous or mismatched targets', () => {
    const files = recordedWorkingFiles(
      [
        tool({ rawInput: { filePath: 'reports/one.md' } }),
        tool({ toolLocations: [{ path: 'D:\\other\\one.md' }] })
      ],
      'C:\\workspace'
    )
    expect(resolveMessageArtifactReference('reports/one.md', files)?.path).toBe(
      'C:\\workspace\\reports\\one.md'
    )
    expect(resolveMessageArtifactReference('one.md', files)).toBeUndefined()
    expect(resolveMessageArtifactReference('C:/missing/one.md', files)).toBeUndefined()
    expect(resolveMessageArtifactReference('file:///C:/workspace/reports/one.md', files)).toBe(
      files[0]
    )
    expect(
      recordedWorkingFiles(
        [tool({ status: 'failed', rawInput: { path: 'failed.md' } })],
        '/workspace'
      )
    ).toEqual([])
  })

  it('reconstructs historical evidence from its own turn and never borrows later same-name files', () => {
    const messages = [
      { id: 'p1', role: 'user', createdAt: 1 },
      { id: 'm1', role: 'agent', responseToMessageId: 'p1', createdAt: 3 },
      { id: 'p2', role: 'user', createdAt: 4 },
      { id: 'm2', role: 'agent', responseToMessageId: 'p2', createdAt: 6 }
    ] as ChatSession['messages']
    const session = {
      id: 'session',
      projectId: 'project',
      cwd: '/workspace',
      messages,
      activities: [
        tool({ rawInput: { path: 'old/report.md' }, promptMessageId: 'p1' }),
        tool({ rawInput: { path: 'new/report.md' }, promptMessageId: 'p2', createdAt: 5 })
      ]
    } as ChatSession
    expect(workingFilesForMessage(session, messages[1]).map(({ path }) => path)).toEqual([
      '/workspace/old/report.md'
    ])
    expect(workingFilesForMessage(session, messages[3]).map(({ path }) => path)).toEqual([
      '/workspace/new/report.md'
    ])
  })
})
