import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReviewerTurnFileEvidenceReader } from './reviewer-turn-file-evidence-reader'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('ReviewerTurnFileEvidenceReader', () => {
  it('upgrades an artifact-only input when the same Version was directly read by a later run', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'reviewer-turn-file-evidence-'))
    const source = 'sample,value\na,1\n'
    const output = 'result,value\na,2\n'
    const sourceKey = 'uploads/project-1/source-version/content'
    const outputKey = 'artifacts/project-1/session-1/work-version/content'
    for (const [key, content] of [
      [sourceKey, source],
      [outputKey, output]
    ]) {
      const path = join(storageRoot, ...key.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
    const checksum = (content: string): string => createHash('sha256').update(content).digest('hex')
    const findMany = vi.fn(async () => [
      {
        id: 'work-version',
        messageId: 'agent-1',
        producerRunId: 'producer-run',
        evidenceJson: JSON.stringify({ producer: { state: 'available' } }),
        filename: 'result.csv',
        contentType: 'text/csv',
        sizeBytes: BigInt(Buffer.byteLength(output)),
        checksum: checksum(`${output}tampered`),
        contentStorageKey: outputKey,
        inputs: [
          {
            inputFileVersionId: 'source-version',
            filename: 'source.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(Buffer.byteLength(source)),
            checksum: checksum(source),
            storageKey: sourceKey,
            strongestAssociation: 'turn-attached'
          }
        ]
      }
    ])
    const reader = new ReviewerTurnFileEvidenceReader({
      storageRoot,
      getClient: async () => ({ artifactVersion: { findMany } }) as never,
      notebookRepository: {
        readSessionDocuments: async () => [
          {
            runs: [
              {
                runId: 'direct-run',
                promptMessageId: 'user-1',
                inputFiles: [
                  {
                    inputFileVersionId: 'source-version',
                    sourceKind: 'upload-version',
                    sourceFileId: 'upload-1',
                    sourceProjectId: 'project-1',
                    sourceSessionId: 'source-session',
                    filename: 'source.csv',
                    contentType: 'text/csv',
                    sizeBytes: Buffer.byteLength(source),
                    checksum: checksum(source),
                    storageKey: sourceKey,
                    association: 'resolver-accessed'
                  }
                ]
              }
            ]
          } as never
        ]
      }
    })

    const records = await reader.resolve({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionIds: ['work-version'],
      messageIds: ['user-1', 'agent-1']
    })

    expect(records).toEqual([
      expect.objectContaining({
        versionId: 'work-version',
        role: 'work_product',
        contentStatus: 'checksum-mismatch'
      }),
      expect.objectContaining({
        versionId: 'source-version',
        role: 'source_document',
        scopeReason: 'read-by-turn',
        executionId: 'direct-run',
        directlyRead: true,
        contentStatus: 'available'
      })
    ])
  })
})
