import { expect, it } from 'vitest'
import { isPdfTranslationCaption } from '../../src/reader/layout'

it.each([
  ['Figure 2 flips the comparison between groups.', false],
  ['Figure 3 clarifies in more detail the change between groups.', false],
  ['Figure 4 assesses the effect of the settings.', false],
  ['Figure 4: Assesses the effect of the settings.', true],
  ['Figure 2: Flips between measured states.', true],
  ['Figure 3. Clarifies the notation used below.', true]
])('keeps finite figure references in body prose: %s', (text, caption) => {
  expect(isPdfTranslationCaption(text)).toBe(caption)
})
