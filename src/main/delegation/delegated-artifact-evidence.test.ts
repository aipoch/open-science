import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ArtifactFile } from '../../shared/artifacts'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { createDelegatedArtifactEvidence } from './delegated-artifact-evidence'

const roots: string[] = []

describe('delegated Artifact evidence adapter', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('uses the real Artifact turn owner and projects finalized evidence by exact Attempt scope', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-artifact-evidence-'))
    roots.push(dataRoot)
    const versionsByRun = new Map<string, ArtifactFile[]>()
    const durable: Array<{
      scope: { attemptId: string; terminalMessageId?: string }
      file: ArtifactFile
    }> = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      now: () => 10,
      provenance: {
        listRunVersions: async ({ artifactRunId }) => versionsByRun.get(artifactRunId) ?? [],
        writeAppGeneratedVersion: async (request) => {
          const file: ArtifactFile = {
            id: `version-${request.artifactRunId}`,
            artifactId: `artifact-${request.agentFrameId}`,
            versionId: `version-${request.artifactRunId}`,
            versionNumber: 1,
            checksum: request.content,
            createdAt: '2026-08-07T00:00:00.000Z',
            projectName: request.projectId,
            sessionId: request.appSessionId,
            runId: request.artifactRunId,
            name: request.filename,
            path: `/managed/${request.filename}`,
            fileUrl: `file:///managed/${request.filename}`,
            size: request.content.length,
            mtimeMs: 1
          }
          versionsByRun.set(request.artifactRunId, [file])
          return file
        }
      }
    })
    const evidence = createDelegatedArtifactEvidence({
      turns: owner,
      artifactStorageSessionId: ({ sessionId }) => `artifact-${sessionId}`,
      finalizePublication: async (publication, terminalMessageId, scope) => {
        for (const file of publication.artifacts) {
          durable.push({ scope: { attemptId: scope.attemptId, terminalMessageId }, file })
        }
      },
      project: async (scope) =>
        durable
          .filter(
            (entry) =>
              entry.scope.attemptId === scope.attemptId &&
              entry.scope.terminalMessageId === scope.terminalMessageId
          )
          .map(({ file }) => file)
    })
    const scope = {
      session: { projectId: 'project-1', sessionId: 'session-1' },
      executionId: 'attempt-1',
      attemptId: 'attempt-1',
      rootFrameId: 'root-frame',
      agentFrameId: 'child-frame',
      messageBranchId: 'child-branch',
      runtimeSegmentId: 'child-segment',
      promptMessageId: 'child-prompt',
      agentName: 'Main Agent'
    }

    const handle = await evidence.open(scope)
    expect(handle.execution?.currentRunFile).toMatch(
      /\.execution-handoffs\/artifact-run-10-1\.json$/
    )
    const ownerHandle = owner.handleForExecution('attempt-1')
    await owner.write(ownerHandle, { filename: 'child.md', content: 'child bytes' })
    await handle.finalize('terminal-message')
    await handle.dispose()

    await expect(
      evidence.project({
        ...scope,
        runtimeSegmentIds: ['child-segment'],
        terminalMessageId: 'terminal-message'
      })
    ).resolves.toMatchObject([
      {
        name: 'child.md',
        artifactId: 'artifact-child-frame',
        checksum: 'child bytes'
      }
    ])
    await expect(
      owner.write(ownerHandle, { filename: 'late.md', content: 'late' })
    ).rejects.toThrow('not open')
  })
})
