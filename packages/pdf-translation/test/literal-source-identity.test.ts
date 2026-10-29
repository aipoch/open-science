import { expect, it } from 'vitest'
import { literalSourceIdentity } from '../resources/literal-source-identity.mjs'
import { mapReflowLinks } from '../resources/reflow-links.mjs'

it('binds a unique native link occurrence inside one unchanged complete source paragraph', () => {
  const source = 'The result follows from statements 7 to 9.',
    translation = 'Translated introduction: ' + source
  for (const label of ['7', '9']) {
    const offset = source.indexOf(label),
      target = literalSourceIdentity(source, translation, label, offset)
    expect(target).toEqual({ start: translation.indexOf(source) + offset, text: label })
  }
})

it.each([
  ['repeated complete paragraph', 'A result 7.', 'A result 7. A result 7.', '7', 9],
  ['changed paragraph', 'A result 7.', 'A changed result 7.', '7', 9],
  ['partial paragraph', 'A complete result 7.', 'result 7.', '7', 18],
  ['ambiguous label', '1. A and 1. B', 'Prefix 1. A and 1. B', '1.', 0],
  ['wrong offset', 'A result 7.', 'Prefix A result 7.', '7', 8],
  ['changed line ending', 'A\r\nresult 7.', 'Prefix A\nresult 7.', '7', 10]
] as const)('rejects %s', (_name, source, translation, label, offset) => {
  expect(literalSourceIdentity(source, translation, label, offset)).toBeUndefined()
})

it('preserves UTF16 offsets and exact newline and protected literal bytes', () => {
  const source = '𝛼\nComplete result 7.\r\n𝛽',
    translation = '𝛾 ' + source,
    offset = source.indexOf('7')
  expect(literalSourceIdentity(source, translation, '7', offset)).toEqual({
    start: 3 + offset,
    text: '7'
  })
  expect(literalSourceIdentity('A 𝛼 B', 'Prefix A 𝛼 B', '\udfbc', 3)).toBeUndefined()
})

it.each(['text', 'code', 'formula'])(
  'only extends ordinary text source origins, leaving protected %s routing unchanged',
  (kind) => {
    const source = 'The complete statement is 7.',
      translation = 'Prefix ' + source,
      rect = { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
      result = mapReflowLinks(
        {
          links: [
            {
              pageNumber: 1,
              index: 0,
              labels: ['7'],
              regions: [rect],
              destination: { pageNumber: 2, mode: 1, params: [0, 100, null] }
            }
          ],
          geometry: [{ left: 0, top: 100, width: 100, height: 100 }],
          outlines: [],
          outlineCount: 0
        },
        { units: [{ source, translation, kind, fragments: [{ pageNumber: 1, rect }] }] },
        {
          originals: new Map([[2, 2]]),
          crops: [],
          placements: new Map(),
          sourcePages: [],
          firstContent: new Map(),
          lines: new Map([[0, [{ text: translation, start: 0, pageNumber: 1, rect }]]])
        },
        (text: string): number => text.length
      )
    expect(result.failed.has(1)).toBe(kind !== 'text')
    expect(result.mapped.length).toBe(kind === 'text' ? 1 : 0)
  }
)
