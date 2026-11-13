import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { captionKind } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)

it.each([
  'Table 1 Review results.',
  'Table 2 Review quality across domains.',
  'Table 3 Review generation with independent controls.'
])('retains a singular table subject followed by the noun title %s', (text) => {
  expect(captionKind(text)).toBe('table')
})
it.each([
  'Table 1 reviews the results.',
  'Table 1 and Table 2 review the results.',
  'Tables 1 and 2 review the results.',
  'Figure 1 reviews the results.',
  'Figure 1 (a) and (b) review the results.',
  'Figure 1(a) and (b) review the results.',
  'Figure 1 (a), (b), and (c) review the results.',
  'Table 1 a and b review the results.'
])('keeps the finite narrative reference %s outside caption ownership', (text) => {
  expect(captionKind(text)).toBeUndefined()
})
