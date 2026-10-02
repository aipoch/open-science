import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { readingRotation } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-orientation.mjs')).href
)

it('associates French numbered table labels without rewriting their source spelling', () => {
  const lines = [
    { text: 'Tableau 1', x: 40, y: 50, width: 60, height: 10, fontSize: 10 },
    { text: 'Comparaison des groupes', x: 40, y: 65, width: 160, height: 10, fontSize: 10 }
  ]
  expect(captionKind(lines[0].text)).toBe('table')
  const captions = findCaptionCandidates([{ pageNumber: 1, width: 600, height: 800, lines }])
  expect(captions[0].lines[0]).toBe('Tableau 1')
})

it.each([90, 270])(
  'uses a spaced native table label beside upright prose at %s degrees',
  (angle) => {
    const rotated = (str: string): Record<string, unknown> => ({
      str,
      dir: 'ltr',
      width: str.length * 5,
      height: 10,
      transform: angle === 90 ? [0, 10, -10, 0, 40, 60] : [0, -10, 10, 0, 40, 60]
    })
    const content = {
      items: [
        rotated('T A B L E 2'),
        rotated('Measured values '.repeat(10)),
        {
          str: 'Table S2 in the ESM). Similarly, differences between means',
          dir: 'ltr',
          width: 500,
          height: 10,
          transform: [10, 0, 0, 10, 300, 500]
        },
        {
          str: 'Independent ordinary prose '.repeat(40),
          dir: 'ltr',
          width: 500,
          height: 10,
          transform: [10, 0, 0, 10, 300, 480]
        }
      ]
    }
    expect(readingRotation({ rotate: 0 }, content)).toBe(angle)
    content.items[0].str = 'Axis label'
    expect(readingRotation({ rotate: 0 }, content)).toBe(0)
  }
)
it('recognizes a parenthesized continuation heading without accepting an inline reference', () => {
  expect(captionKind('(Table 1) Contd….')).toBe('table')
  expect(captionKind('(Table 2) Continued.')).toBe('table')
  expect(captionKind('(Table 1) contains the measurements.')).toBeUndefined()
})
