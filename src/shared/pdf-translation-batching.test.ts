import { expect, it } from 'vitest'
import { pdfTranslationBatchSourceIndices } from './pdf-translation-batching'

it('bounds batches by characters, unit count, literal cells and unavailable gaps', () => {
  expect(pdfTranslationBatchSourceIndices(Array(8).fill('ATP increased.'), 0)).toEqual([0, 1, 2, 3])
  expect(pdfTranslationBatchSourceIndices(Array(8).fill('a'.repeat(600)), 0)).toEqual([0, 1, 2])
  for (const literal of ['A0', '<.001c', '2.4', 'a'.repeat(601)])
    expect(
      pdfTranslationBatchSourceIndices(['ATP increased.', literal, 'ATP increased.'], 0)
    ).toEqual([0])
  expect(
    pdfTranslationBatchSourceIndices(Array(8).fill('ATP increased.'), 0, (index) => index === 2)
  ).toEqual([0, 1])
})
