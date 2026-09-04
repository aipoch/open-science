import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { TurnScope } from '../../shared/reviewer'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import { createPngBytes } from '../artifacts/artifact-test-fixtures'
import { createProvenanceTestFixture, provenanceGraph } from '../artifacts/provenance-test-fixtures'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ReviewerHostServer } from './host-sdk'
import { ReviewerMcpServer } from './mcp-server'
import { callSubmitFindingsAfterReadingEvidence } from './reviewer-mcp-test-client'

describe('Reviewer image-generation trace fixture', () => {
  it('consolidates method, execution result, and attachment existence without reading pixels', async () => {
    const fixture = await createProvenanceTestFixture()
    let mcp: ReviewerMcpServer | undefined
    try {
      await fixture.client.project.create({ data: { id: 'project-1', name: 'Project one' } })
      const managedFileVersions = new ManagedFileVersionService({
        storageRoot: fixture.storageRoot,
        getClient: () => Promise.resolve(fixture.client)
      })
      const lane = createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1')
      const notebook = await fixture.notebookRepository.loadOrCreate({
        projectId: 'project-1',
        sessionId: 'session-1',
        lane,
        workspaceCwd: '/workspace'
      })
      const sourcePath = join(notebook.notebookSessionRoot, 'data', 'generated.png')
      const imageBytes = createPngBytes('opaque pixels are intentionally never reviewed')
      await mkdir(dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, imageBytes)
      const sourceStat = await stat(sourcePath)
      await fixture.notebookRepository.appendRun({
        projectId: 'project-1',
        sessionId: 'session-1',
        lane,
        run: {
          runId: 'image-run-1',
          cellId: 'cell-image-1',
          source: 'agent',
          kernelKind: 'python',
          script: "generate_image(method='heatmap', output='generated.png')",
          status: 'completed',
          startedAt: sourceStat.mtimeMs - 100,
          endedAt: sourceStat.mtimeMs + 100,
          text: { stdout: 'saved generated.png', stderr: '', traceback: '', plain: [] },
          outputs: [{ type: 'stream', name: 'stdout', text: 'saved generated.png' }],
          artifacts: [],
          workingFiles: [
            {
              path: sourcePath,
              relativePath: 'data/generated.png',
              kind: 'other',
              size: sourceStat.size,
              mtimeMs: sourceStat.mtimeMs,
              createdByRunId: 'image-run-1'
            }
          ],
          inputFiles: [],
          ...provenanceGraph
        }
      })
      await fixture.stagePng('opaque pixels are intentionally never reviewed', 'generated.png')
      const version = await fixture.repository.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-image-1',
        writeRequestChecksum: 'a'.repeat(64),
        ...provenanceGraph,
        notebookSessionId: 'session-1',
        producerRunId: 'image-run-1',
        sourceFileObservation: {
          path: await realpath(sourcePath),
          sizeBytes: sourceStat.size,
          mtimeMs: sourceStat.mtimeMs
        },
        filename: 'generated.png',
        contentType: 'image/png'
      })

      const activityId = 'activity-image-generation'
      const messageId = 'message-image-result'
      const session: PersistedChatSession = {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Image generation trace',
        cwd: '/workspace',
        status: 'idle',
        messages: [
          {
            id: messageId,
            role: 'agent',
            content: 'Generated and attached generated.png using the heatmap method.',
            status: 'complete',
            eventIds: [],
            artifactIds: [version.versionId],
            createdAt: 2,
            updatedAt: 2
          }
        ],
        activities: [
          {
            id: activityId,
            kind: 'tool',
            title: 'Generate heatmap image',
            status: 'completed',
            sortIndex: 0,
            eventIds: [],
            rawInput: { method: 'heatmap', output: 'generated.png' },
            rawOutput: { saved: true, artifactVersionId: version.versionId },
            terminalOutput: 'saved generated.png',
            terminalExitCode: 0,
            createdAt: 1,
            updatedAt: 1
          }
        ],
        artifacts: [
          {
            id: version.versionId,
            artifactId: version.artifactId,
            versionId: version.versionId,
            versionNumber: version.versionNumber,
            kind: 'managed-file',
            path: version.path,
            name: version.name,
            mimeType: version.mimeType,
            size: version.size,
            sha256: version.checksum,
            createdAt: Date.parse(version.createdAt)
          }
        ],
        createdAt: 0,
        updatedAt: 2
      }
      const scope: TurnScope = {
        turnMessageId: messageId,
        blocks: [
          {
            id: `activity:${activityId}`,
            kind: 'activity',
            sourceId: activityId,
            blockIndex: 0,
            contentHash: 'activity-hash'
          },
          {
            id: `message:${messageId}`,
            kind: 'message',
            sourceId: messageId,
            blockIndex: 1,
            contentHash: 'message-hash'
          }
        ],
        artifactVersionIds: [version.versionId]
      }
      const contentResolver = vi.fn(async (request: { projectId: string; versionId: string }) => {
        const lease = await managedFileVersions.openVersion(
          {
            source: 'artifact',
            projectId: request.projectId,
            fileId: version.artifactId
          },
          request.versionId
        )
        return {
          path: lease.path,
          filename: lease.version.filename,
          ...(lease.version.contentType ? { contentType: lease.version.contentType } : {}),
          checksum: lease.version.checksum,
          size: lease.size,
          readRange: lease.readRange,
          verifyUnchanged: lease.verifyUnchanged,
          close: lease.close
        }
      })
      const host = new ReviewerHostServer(
        session,
        scope,
        fixture.storageRoot,
        contentResolver,
        undefined,
        {},
        (request) => fixture.repository.getReviewerVersionTrace(request)
      )
      const submitted = vi.fn().mockResolvedValue(undefined)
      mcp = new ReviewerMcpServer(scope, submitted, host, 'initial')
      const { endpoint, token } = await mcp.start()

      await callSubmitFindingsAfterReadingEvidence(
        endpoint,
        token,
        [
          {
            status: 'pass',
            claim: 'The image generation method, successful result, and attachment exist.',
            evidence:
              'Captured Run image-run-1 executed the heatmap generation code, the execution log reports saved generated.png, and the immutable Artifact Version is attached.',
            artifactVersionId: version.versionId,
            locator: {
              blockRef: { activityId, blockIndex: 0 },
              contentHash: 'activity-hash'
            }
          }
        ],
        { artifactView: 'trace' }
      )

      expect(submitted).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            status: 'pass',
            artifactVersionId: version.versionId,
            claim: expect.stringMatching(/method.*result.*attachment/i)
          })
        ],
        scope,
        {}
      )
      expect(contentResolver).not.toHaveBeenCalled()
      expect(mcp.evidenceCoverage.artifactReads?.get(version.versionId)).toMatchObject({
        traceRead: true,
        contentRead: false,
        mediaRead: false
      })
    } finally {
      await mcp?.stop().catch(() => undefined)
      await fixture.dispose()
    }
  })
})
