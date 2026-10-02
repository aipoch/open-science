import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { recoverPriorPageTableCaption } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-group.mjs')).href
)
type Page = {
  pageNumber: number
  width: number
  height: number
  lines: { text: string; x: number; y: number; width: number; height: number }[]
}
function input(): {
  previous: Page
  page: Page
  captions: { page: number; lines: string[]; rect: number[] }[]
  table: { cropRect: number[]; structure: { objects: { label: string }[] } }
  rules: number[][]
  tokens: { text: string; horizontal: boolean; height: number; rect: number[] }[]
} {
  const previous = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text: 'Table 4. Native descriptors.', x: 50, y: 720, width: 220, height: 10 }]
  }
  const page = {
    pageNumber: 2,
    width: 600,
    height: 800,
    lines: [{ text: 'Table 5. Native records.', x: 50, y: 720, width: 200, height: 10 }]
  }
  const captions = [
    { page: 1, lines: [previous.lines[0].text], rect: [50, 720, 270, 730] },
    { page: 2, lines: [page.lines[0].text], rect: [50, 720, 250, 730] }
  ]
  const table = {
    cropRect: [75, 100, 825, 600],
    structure: { objects: Array.from({ length: 3 }, () => ({ label: 'table column' })) }
  }
  const rules = [
    [75, 110, 825, 110],
    [75, 150, 825, 150],
    ...[75, 300, 600, 825].map((x) => [x, 110, x, 150])
  ]
  const tokens = ['Key', 'Descriptor', 'Unit'].map((text, i) => ({
    text,
    horizontal: true,
    height: 15,
    rect: [100 + i * 250, 120, 170 + i * 250, 135]
  }))
  return { previous, page, captions, table, rules, tokens }
}
it('uses the unique terminal title above a next-page native closed header', () => {
  const s = input()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [s.previous, s.page],
      s.captions,
      s.captions[1]
    )
  ).toBe(s.captions[0])
})
it('rejects a missing native cut, competing prior title, nonterminal prose, or current title above the frame', () => {
  const s = input()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules.slice(0, -1),
      s.page,
      [s.previous, s.page],
      s.captions,
      s.captions[1]
    )
  ).toBeUndefined()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [s.previous, s.page],
      [...s.captions, { ...s.captions[0], lines: ['Table 6. Another title.'] }],
      s.captions[1]
    )
  ).toBeUndefined()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [
        {
          ...s.previous,
          lines: [
            ...s.previous.lines,
            { text: 'A separate body paragraph.', x: 50, y: 740, width: 250, height: 10 }
          ]
        },
        s.page
      ],
      s.captions,
      s.captions[1]
    )
  ).toBeUndefined()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [s.previous, s.page],
      s.captions,
      { ...s.captions[1], rect: [50, 30, 250, 40] }
    )
  ).toBeUndefined()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [s.previous, s.page],
      [
        ...s.captions,
        { page: 2, lines: ['Table 8. A native header title.'], rect: [50, 35, 250, 45] }
      ],
      undefined
    )
  ).toBeUndefined()
})
