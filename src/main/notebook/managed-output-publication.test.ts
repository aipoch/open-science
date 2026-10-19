import { expect, it } from 'vitest'
import {
  freezeManagedOutputWriteAttempt,
  managedOutputWriteAttemptSchema,
  type ManagedOutputWriteAttempt
} from './managed-output-publication'

const fixture = (): ManagedOutputWriteAttempt => ({
  schemaVersion: 1 as const,
  request: {
    projectId: 'p',
    appSessionId: 's',
    artifactStorageSessionId: 'storage-s',
    artifactRunId: 'artifact-run',
    writeOperationId: 'operation-write',
    filename: 'result.txt',
    producerRunId: 'run'
  },
  destination: {
    provenanceContext: {
      rootFrameId: 'root',
      agentFrameId: 'agent',
      messageBranchId: 'branch',
      runtimeSegmentId: 'segment',
      promptMessageId: 'prompt'
    },
    messageAncestry: ['prompt']
  },
  source: {
    kind: 'managedOutput' as const,
    sha256: 'a'.repeat(64),
    sizeBytes: 8,
    producerRunId: 'run',
    producerProvenance: {
      rootFrameId: 'root',
      agentFrameId: 'agent',
      messageBranchId: 'branch',
      runtimeSegmentId: 'segment',
      promptMessageId: 'prompt'
    },
    generationId: 'generation',
    relativePath: 'result.txt'
  }
})
it('strictly snapshots and freezes the complete durable intent without serializing capabilities', () => {
  const input = fixture()
  const attempt = freezeManagedOutputWriteAttempt(input)
  input.request.artifactRunId = 'changed'
  input.destination.messageAncestry.push('changed')
  input.source.producerProvenance!.promptMessageId = 'changed'
  expect(attempt).toEqual(fixture())
  expect(Object.isFrozen(attempt)).toBe(true)
  expect(Object.isFrozen(attempt.request)).toBe(true)
  expect(Object.isFrozen(attempt.destination.messageAncestry)).toBe(true)
  expect(Object.isFrozen(attempt.source.producerProvenance)).toBe(true)
  expect(JSON.parse(JSON.stringify(attempt))).toEqual(fixture())
})
it.each([
  (v: ReturnType<typeof fixture>) => ({ ...v, authority: {} }),
  (v: ReturnType<typeof fixture>) => ({
    ...v,
    request: { ...v.request, source: { path: '/private/file' } }
  }),
  (v: ReturnType<typeof fixture>) => ({
    ...v,
    source: { ...v.source, relativePath: '/private/file' }
  }),
  (v: ReturnType<typeof fixture>) => ({ ...v, source: { ...v.source, relativePath: '../file' } }),
  (v: ReturnType<typeof fixture>) => ({ ...v, source: { ...v.source, relativePath: undefined } }),
  (v: ReturnType<typeof fixture>) => ({ ...v, source: { ...v.source, sha256: 'incorrect' } }),
  (v: ReturnType<typeof fixture>) => ({ ...v, source: { ...v.source, sizeBytes: -1 } }),
  (v: ReturnType<typeof fixture>) => ({ ...v, source: { ...v.source, producerRunId: 'other' } }),
  (v: ReturnType<typeof fixture>) => ({
    ...v,
    source: { ...v.source, producerProvenance: undefined }
  }),
  (v: ReturnType<typeof fixture>) => ({ ...v, source: { ...v.source, kind: 'inline' } }),
  (v: ReturnType<typeof fixture>) => ({
    ...v,
    destination: { ...v.destination, messageAncestry: ['unrelated'] }
  })
])('rejects incomplete, forged or inconsistent durable intent %#', (mutate) => {
  expect(managedOutputWriteAttemptSchema.safeParse(mutate(fixture())).success).toBe(false)
})
it('accepts an inline receipt with no invented producer or source generation', () => {
  const input = fixture()
  expect(
    managedOutputWriteAttemptSchema.parse({
      ...input,
      request: { ...input.request, producerRunId: undefined },
      source: { kind: 'inline', sha256: input.source.sha256, sizeBytes: 8 }
    }).source
  ).toEqual({ kind: 'inline', sha256: input.source.sha256, sizeBytes: 8 })
})
