import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { createTaskCallerContext } from '../caller-context'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ArtifactLineageProvenance } from '../../shared/artifact-provenance'
import type { NotebookRunInputFile } from '../../shared/notebook'
import { ResearchReplayService, type ResearchReplayDependencies } from './service'

export function researchReplayHarness(): {
  service: ResearchReplayService
  dependencies: ResearchReplayDependencies
  caller: ReturnType<typeof createTaskCallerContext>
  session: PersistedChatSession
  target: { projectId: string; sessionId: string }
  content: Buffer
  setCurrent(value: boolean): void
} {
  let current = true
  const target = { projectId: 'project', sessionId: 'session' },
    content = Buffer.from('saved result bytes'),
    checksum = createHash('sha256').update(content).digest('hex')
  const session: PersistedChatSession = {
    id: target.sessionId,
    projectId: target.projectId,
    title: 'Research',
    cwd: '/author/private/path',
    status: 'idle',
    messages: [
      {
        id: 'q',
        role: 'user',
        content: 'Why test this?',
        status: 'complete',
        createdAt: 1000,
        updatedAt: 1000,
        eventIds: []
      },
      {
        id: 'a',
        role: 'agent',
        content: 'The saved result is attached.',
        status: 'complete',
        createdAt: 5000,
        updatedAt: 5000,
        eventIds: [],
        responseToMessageId: 'q'
      }
    ],
    createdAt: 1000,
    updatedAt: 5000,
    artifacts: [
      {
        id: 'artifact',
        kind: 'managed-file',
        path: 'result.txt',
        artifactId: 'artifact',
        versionId: 'version',
        name: 'result.txt',
        mimeType: 'text/plain',
        size: content.length,
        sha256: checksum,
        createdAt: 4000
      }
    ]
  }
  const caller = createTaskCallerContext({
    clientId: 'owner',
    isAuthorizationCurrent: () => current
  })
  const input: NotebookRunInputFile = {
    sourceKind: 'artifact-version',
    sourceProjectId: target.projectId,
    sourceSessionId: target.sessionId,
    sourceFileId: 'artifact',
    inputFileVersionId: 'version',
    sourceVersionNumber: 1,
    filename: 'result.txt',
    sizeBytes: content.length,
    checksum,
    storageKey: 'saved',
    association: 'turn-attached'
  }
  const dependencies: ResearchReplayDependencies = {
    reader: {
      sessions: { loadOne: vi.fn(async () => session) },
      notebook: {
        runIndex: vi.fn(async () => []),
        getReference: vi.fn(async () => null),
        state: vi.fn()
      },
      artifacts: {
        getLineage: vi.fn(
          async () =>
            ({
              artifactId: 'artifact',
              versions: [
                {
                  artifactId: 'artifact',
                  versionId: 'version',
                  versionNumber: 1,
                  name: 'result.txt',
                  mimeType: 'text/plain',
                  size: content.length,
                  checksum,
                  createdAt: new Date(4000).toISOString()
                }
              ]
            }) as ArtifactLineageProvenance
        )
      }
    },
    recordings: {
      read: vi.fn(),
      readProject: vi.fn(),
      readBrowser: vi.fn(),
      readMedia: vi.fn(),
      readProjectMedia: vi.fn(),
      readBrowserMedia: vi.fn(),
      selectBrowserMoment: vi.fn(),
      selectFile: vi.fn()
    },
    immutable: {
      resolveVersion: vi.fn(async () => input),
      openContent: vi.fn(
        async () =>
          ({
            readRange: async (offset: number, length: number) =>
              content.subarray(offset, offset + length),
            verifyUnchanged: async () => undefined,
            close: async () => undefined
          }) as never
      )
    },
    authorize: vi.fn(async () => undefined),
    readRun: vi.fn(async () => undefined)
  }
  return {
    service: new ResearchReplayService(dependencies),
    dependencies,
    caller,
    session,
    target,
    content,
    setCurrent: (value) => {
      current = value
    }
  }
}
