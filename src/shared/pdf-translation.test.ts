import { describe, expect, it } from 'vitest'
import type { PdfDocumentSource } from './pdf-document-source'
import {
  pdfTranslationCheckpointMatchesSource,
  pdfTranslationCheckpointSchema,
  pdfTranslationDocumentSourceSchema,
  pdfTranslationSourceKey
} from './pdf-translation'

const source: PdfDocumentSource = {
  kind: 'upload-version',
  projectId: 'project',
  sourceFileId: 'file',
  versionId: 'version',
  checksum: 'a'.repeat(64),
  name: 'paper.pdf',
  path: 'upload-version:version'
}
const base = {
  version: 1,
  key: '110ce2bd-7610-453e-abfd-dbd905d1e8c5',
  revision: 1,
  checksum: source.checksum,
  fingerprint: 'fingerprint',
  language: 'Chinese',
  glossary: [],
  targetKey: 'b'.repeat(64),
  model: { frameworkId: 'direct-api', mode: 'api' },
  sources: ['A paragraph.'],
  translations: ['一个段落。'],
  translatedSourceIndices: [0]
}

describe('PDF translation source contract', () => {
  it.each([{ version: 2 }, { translatedSourceIndices: undefined }])(
    'rejects unsupported checkpoint formats %j',
    (change) => {
      expect(
        pdfTranslationCheckpointSchema.safeParse({
          ...base,
          attachmentVersionId: 'version',
          ...change
        }).success
      ).toBe(false)
    }
  )

  it('persists the exact API provider and model for checkpoint recovery', () => {
    const model = {
      frameworkId: 'direct-api',
      mode: 'api',
      providerId: 'chosen-provider',
      modelId: 'chosen-model'
    }
    const checkpoint = pdfTranslationCheckpointSchema.parse(
      JSON.parse(JSON.stringify({ ...base, model, documentSource: source }))
    )
    expect(checkpoint.model).toEqual(model)
  })
  it('keeps historical Literature checkpoints compatible', () => {
    const checkpoint = pdfTranslationCheckpointSchema.parse({
      ...base,
      attachmentVersionId: 'version'
    })
    expect(pdfTranslationCheckpointMatchesSource(checkpoint, 'version')).toBe(true)
    expect(pdfTranslationCheckpointMatchesSource(checkpoint, 'another-version')).toBe(false)
    expect(pdfTranslationCheckpointMatchesSource(checkpoint, source)).toBe(false)
  })

  it.each(['upload-version', 'artifact-version'] as const)(
    'accepts an immutable %s checkpoint',
    (kind) => {
      const documentSource = { ...source, kind }
      const checkpoint = pdfTranslationCheckpointSchema.parse({ ...base, documentSource })
      expect(pdfTranslationCheckpointMatchesSource(checkpoint, documentSource)).toBe(true)
      expect(pdfTranslationCheckpointMatchesSource(checkpoint, 'version')).toBe(false)
    }
  )

  it.each([
    {},
    { attachmentVersionId: 'version', documentSource: source },
    { documentSource: { ...source, kind: 'literature-attachment-version' } },
    { documentSource: { ...source, projectId: undefined } },
    { documentSource: { ...source, checksum: 'c'.repeat(64) } }
  ])('rejects ambiguous, unowned or mismatched checkpoint source %j', (identity) => {
    expect(pdfTranslationCheckpointSchema.safeParse({ ...base, ...identity }).success).toBe(false)
  })

  it.each([
    { projectId: 'other-project' },
    { kind: 'artifact-version' },
    { sourceFileId: 'other-file' },
    { versionId: 'other-version' },
    { checksum: 'c'.repeat(64) }
  ] as const)('isolates workspace checkpoint by identity %j', (change) => {
    const checkpoint = pdfTranslationCheckpointSchema.parse({ ...base, documentSource: source })
    const other = { ...source, ...change }
    expect(pdfTranslationSourceKey(other)).not.toBe(pdfTranslationSourceKey(source))
    expect(pdfTranslationCheckpointMatchesSource(checkpoint, other)).toBe(false)
  })

  it('does not invalidate a version when its display name or path changes', () => {
    const checkpoint = pdfTranslationCheckpointSchema.parse({ ...base, documentSource: source })
    const renamed = { ...source, name: 'renamed.pdf', path: 'display-hint.pdf' }
    expect(pdfTranslationCheckpointMatchesSource(checkpoint, renamed)).toBe(true)
  })

  it.each([
    undefined,
    'path.pdf',
    { ...source, checksum: 'fingerprint' },
    { ...source, extra: 'field' }
  ])('rejects malformed document source %j', (value) => {
    expect(pdfTranslationDocumentSourceSchema.safeParse(value).success).toBe(false)
  })
})

it('roundtrips historical source payloads without persisting package-only IDs', async () => {
  const {
    toPackageCheckpoint,
    fromPackageCheckpoint,
    translationSourceReservationKey,
    toTranslationSourceId
  } = await import('./pdf-translation')
  for (const identity of [{ attachmentVersionId: 'version' }, { documentSource: source }]) {
    const checkpoint = pdfTranslationCheckpointSchema.parse({ ...base, ...identity })
    const portable = toPackageCheckpoint(checkpoint)
    expect(portable).not.toHaveProperty('attachmentVersionId')
    expect(portable).not.toHaveProperty('documentSource')
    const restored = fromPackageCheckpoint(structuredClone(portable))
    expect(restored).toEqual(checkpoint)
    expect(JSON.parse(JSON.stringify(restored))).not.toHaveProperty('sourceId')
  }
  const original = toTranslationSourceId(source)
  const renamed = toTranslationSourceId({
    ...source,
    name: 'renamed.pdf',
    path: 'another-display-path'
  })
  expect(translationSourceReservationKey(original)).toBe(translationSourceReservationKey(renamed))
  expect(
    translationSourceReservationKey(
      toTranslationSourceId({ ...source, kind: 'literature-attachment-version' })
    )
  ).toBe(translationSourceReservationKey(toTranslationSourceId(source.versionId)))
})
