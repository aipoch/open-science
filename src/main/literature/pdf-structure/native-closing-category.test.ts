import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
it.each(['native-gutter', 'ordinary-space', 'unmatched-width'])(
  'splits a closing parenthesis from the next category only with a measured %s',
  (variant) => {
    const f = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/native-closing-parenthesis-adjoining-category.jsonl'
      )
    )
    const item = f.content.items[0]
    if (variant === 'ordinary-space') {
      f.operators.argsArray[1][0][1] = -250
      item.width -= ((528 - 250) * item.height) / 1000
    }
    if (variant === 'unmatched-width') item.width += 1
    const original = structuredClone(f)
    const result = splitPdfNumericRuns(f.content, f.operators)
    expect(result.items.map((i: { str: string }) => i.str)).toEqual(
      variant === 'native-gutter' ? [')', 'Full time'] : [') Full time']
    )
    if (variant === 'native-gutter') {
      expect(result.items[0].width).toBeCloseTo((287 * item.height) / 1000, 6)
      expect(result.items[1].transform[4]).toBeCloseTo(
        item.transform[4] + (815 * item.height) / 1000,
        6
      )
    }
    expect(f).toEqual(original)
  }
)
