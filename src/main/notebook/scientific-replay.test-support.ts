import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { expect } from 'vitest'
import type { NotebookExecutionResult } from './runtime-service'

export const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex')

export const decodeSnapshot = (snapshot: {
  bytes: number
  sha256: string
  gzipBase64: string
}): Buffer => {
  const bytes = gunzipSync(Buffer.from(snapshot.gzipBase64, 'base64'))
  expect(bytes.length, 'snapshot byte count').toBe(snapshot.bytes)
  expect(sha256(bytes), 'snapshot checksum').toBe(snapshot.sha256)
  return bytes
}

// Only the fields inspected by the replay tests; this is not a persisted-format definition.
type CapturedEvidence = {
  activityId: string
  evidenceId: string
  relations: Array<{
    relation: string
    relativePath: string
    authority: string
    generation?: {
      generationId: string
      checksum: string
      sizeBytes: number
      contentStorageKey?: string
    }
  }>
}

const portable = (path: string): string => path.replaceAll('\\', '/')

// Call immediately after each execution, before later cells can overwrite working files.
// Expected paths are the audit's final changed files, not all open/write events (which can be
// transient or leave identical bytes). Source-analysis predictions are not the oracle here.
export const verifyReplayCapture = async (
  storageRoot: string,
  result: Pick<NotebookExecutionResult, 'workingFiles' | 'fileEvidence'>,
  expectedWrites: readonly string[]
): Promise<CapturedEvidence> => {
  const files = result.workingFiles ?? []
  const expected = expectedWrites.map(portable).sort()
  expect(files.map((f) => portable(f.relativePath)).sort(), 'captured output paths').toEqual(
    expected
  )
  const summary = result.fileEvidence
  expect(summary?.storageKey, 'evidence storage reference').toBeTruthy()
  expect(summary?.activityId, 'evidence activity reference').toBeTruthy()
  expect(summary?.evidenceId, 'evidence identity reference').toBeTruthy()
  const bytes = await readFile(join(storageRoot, summary!.storageKey!))
  expect(sha256(bytes), 'evidence checksum').toBe(summary!.checksum)
  const captured: CapturedEvidence = JSON.parse(bytes.toString('utf8'))
  expect(captured.activityId, 'evidence activity').toBe(summary!.activityId)
  expect(captured.evidenceId, 'evidence identity').toBe(summary!.evidenceId)
  const written = captured.relations.filter((r) => ['created', 'modified'].includes(r.relation))
  expect(written.map((r) => portable(r.relativePath)).sort(), 'output generation paths').toEqual(
    expected
  )
  for (const file of files) {
    const current = await readFile(file.path)
    expect(sha256(current), `working checksum: ${file.relativePath}`).toBe(file.checksum)
    expect(current.length, `working size: ${file.relativePath}`).toBe(file.size)
    const relation = written.find((r) => portable(r.relativePath) === portable(file.relativePath))!
    expect(relation.relation, `output change: ${file.relativePath}`).toBe(file.change)
    expect(
      relation.generation?.contentStorageKey,
      `stored output: ${file.relativePath}`
    ).toBeTruthy()
    expect(
      relation.generation?.generationId,
      `output generation identity: ${file.relativePath}`
    ).toBe(file.generationId)
    expect(relation.generation?.checksum, `output generation checksum: ${file.relativePath}`).toBe(
      file.checksum
    )
  }
  for (const relation of captured.relations) {
    // Presence alone is never proof of an actual read, including on failed executions.
    if (relation.relation === 'present-before')
      expect(relation.authority, `presence authority: ${relation.relativePath}`).toBe('advisory')
    if (relation.generation?.contentStorageKey) {
      const stored = await readFile(join(storageRoot, relation.generation.contentStorageKey))
      expect(sha256(stored), `stored checksum: ${relation.relativePath}`).toBe(
        relation.generation.checksum
      )
      expect(stored.length, `stored size: ${relation.relativePath}`).toBe(
        relation.generation.sizeBytes
      )
    }
  }
  return captured
}

// This is a test oracle for external inputs, not a runtime read detector. Only a
// confirmed successful truncation can turn a later read into a same-run intermediate.
// Audit-hook notifications fire before open succeeds: attempted truncations alone
// must never erase an input. Append/update writes and earlier reads remain inputs.
export const readPathsBeforeOverwrite = (
  events: readonly {
    path: string
    kind: string
    readable?: boolean
    truncates?: boolean
    successful_open?: boolean
  }[]
): string[] => {
  const overwritten = new Set<string>()
  const inputs = new Set<string>()
  for (const event of events) {
    const path = portable(event.path)
    if (event.kind === 'write' && event.truncates === true && event.successful_open === true)
      overwritten.add(path)
    if ((event.kind === 'read' || event.readable === true) && !overwritten.has(path))
      inputs.add(path)
  }
  return [...inputs].sort()
}
