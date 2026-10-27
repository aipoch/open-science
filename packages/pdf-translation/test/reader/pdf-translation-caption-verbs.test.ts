import { expect, it } from 'vitest'
import { isPdfTranslationCaption } from '../../src/reader/layout'

it.each([
  ['Figure 2 flips the comparison between groups.', false],
  ['Figure 3 clarifies in more detail the change between groups.', false],
  ['Figure 4 assesses the effect of the settings.', false],
  ['Figure 4: Assesses the effect of the settings.', true],
  ['Figure 2: Flips between measured states.', true],
  ['Figure 3. Clarifies the notation used below.', true],
  ['Figure 1 tests the assay.', false],
  ['Fig. 2 on the upper left compares the traces.', false],
  ['Figure 3 on the lower right shows the controls.', false],
  ['Figure 4 on the left presents our models.', false],
  ['Figure 1. Tests of the method.', true],
  ['Figure 1: Tests of the method.', true],
  ['Figure 1 Tests of the method', true],
  ['Figure 1 tests', true],
  ['Figure 1 Testing the method', true],
  ['Figure 1 on the upper left: comparisons', true],
  ['Figure 1 on the upper left comparisons of assays', true],
  ['Fig. 1. On the upper left, compare the controls.', true],
  ['Figure 1 Results on the left', true],
  ['Table 1 tests the method.', true]
])('keeps finite figure references in body prose: %s', (text, caption) => {
  expect(isPdfTranslationCaption(text)).toBe(caption)
})
