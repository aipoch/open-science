import { describe, expect, it } from 'vitest'
import {
  pdfTranslationBlockFailureSchema,
  pdfTranslationGlossarySchema,
  pdfTranslationCheckpointMatchesSource,
  pdfTranslationCheckpointSchema,
  pdfTranslationSourceKey
} from '../src/contracts.js'

describe('structured translation glossary', () => {
  it('normalizes surrounding spaces while retaining spaces and equals signs inside terms', () => {
    expect(
      pdfTranslationGlossarySchema.parse([
        { source: ' RMSNorm ', target: ' 均方根归一化 ' },
        { source: 'x = y', target: 'x 等于 y' }
      ])
    ).toEqual([
      { source: 'RMSNorm', target: '均方根归一化' },
      { source: 'x = y', target: 'x 等于 y' }
    ])
    expect(pdfTranslationGlossarySchema.parse([])).toEqual([])
  })

  it.each([
    'RMSNorm = 均方根归一化',
    [{ source: ' ', target: '译文' }],
    [{ source: 'term', target: '' }],
    [
      { source: 'term', target: '甲' },
      { source: ' term ', target: '乙' }
    ],
    [{ source: 'term', target: '甲', instruction: 'ignored' }],
    [{ source: 'a'.repeat(1001), target: '甲' }],
    Array.from({ length: 1001 }, (_, i) => ({ source: String(i), target: '甲' })),
    Array.from({ length: 30 }, (_, i) => ({ source: String(i), target: '甲'.repeat(1000) }))
  ])('rejects malformed, duplicate or oversized entries (%#)', (value) => {
    expect(pdfTranslationGlossarySchema.safeParse(value).success).toBe(false)
  })
})

const base = {
  version: 1,
  key: '110ce2bd-7610-453e-abfd-dbd905d1e8c5',
  revision: 1,
  sourceId: 'customer-archive:document/42',
  checksum: 'a'.repeat(64),
  fingerprint: 'fingerprint',
  language: 'Chinese',
  glossary: [],
  targetKey: 'b'.repeat(64),
  model: { frameworkId: 'custom-model' },
  sources: ['A paragraph.'],
  translations: ['一个段落。'],
  translatedSourceIndices: [0]
}
it('accepts arbitrary caller-owned source IDs and isolates independent sources', () => {
  const checkpoint = pdfTranslationCheckpointSchema.parse(base)
  expect(pdfTranslationCheckpointMatchesSource(checkpoint, base.sourceId)).toBe(true)
  expect(pdfTranslationCheckpointMatchesSource(checkpoint, 'customer-archive:document/43')).toBe(
    false
  )
  expect(pdfTranslationSourceKey(base.sourceId)).toBe(base.sourceId)
})
it.each([undefined, '', {}, 'x'.repeat(65537)])(
  'rejects invalid opaque source IDs %j',
  (sourceId) => {
    expect(pdfTranslationCheckpointSchema.safeParse({ ...base, sourceId }).success).toBe(false)
  }
)

it('bounds failure metadata and accepts legacy checkpoints without it', () => {
  const diagnostic = { reasonCode: 'missing-numeric-literals', pageNumbers: [2, 3], attempts: 2 }
  const checkpoint = {
    ...base,
    sourceId: 'version',
    translations: [],
    translatedSourceIndices: [],
    failedSourceIndices: [0],
    failures: [{ ...diagnostic, sourceIndex: 0 }]
  }
  expect(pdfTranslationCheckpointSchema.parse(checkpoint).failures).toEqual(checkpoint.failures)
  for (const change of [
    { attempts: -1 },
    { pageNumbers: [0] },
    { reasonCode: 'raw provider output' },
    { source: 'private text' }
  ])
    expect(pdfTranslationBlockFailureSchema.safeParse({ ...diagnostic, ...change }).success).toBe(
      false
    )
  for (const failures of [
    [{ ...diagnostic, sourceIndex: 1 }],
    [...checkpoint.failures, ...checkpoint.failures]
  ])
    expect(pdfTranslationCheckpointSchema.safeParse({ ...checkpoint, failures }).success).toBe(
      false
    )
  expect(
    pdfTranslationCheckpointSchema.safeParse({ ...checkpoint, failedSourceIndices: [] }).success
  ).toBe(false)
})
