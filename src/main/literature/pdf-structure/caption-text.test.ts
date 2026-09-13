import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { joinCaptionLines } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)

it('reflows physical caption lines without losing content or inventing word breaks', () => {
  expect(
    joinCaptionLines([
      'Figure 1. Change from baseline.',
      'Patients who had',
      'both assessments were included.'
    ])
  ).toBe('Figure 1. Change from baseline. Patients who had both assessments were included.')
  expect(joinCaptionLines(['target-', 'lesion assess\u00ad', 'ments'])).toBe(
    'target-lesion assessments'
  )
})
