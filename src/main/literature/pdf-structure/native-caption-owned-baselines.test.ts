import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { nativeCaptionLiteralFragments } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-caption-script-order.mjs'))
    .href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-caption-owned-baselines.jsonl'
    )
  )

it.each(['−', '-'])('retains uniquely attached signed numeric caption exponents (%s)', (minus) => {
  const line = (
    text: string,
    y: number
  ): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
    text,
    x: 50,
    y,
    width: 100,
    height: 10,
    fontSize: 10
  })
  const page = {
    lines: [
      line('Figure 1: The independent observations use 10', 100),
      { ...line(`${minus}2`, 98), x: 150, width: 8, height: 7, fontSize: 7 },
      line('and compare another independent value of 10', 118),
      { ...line(`${minus}3`, 116), x: 150, width: 8, height: 7, fontSize: 7 },
      line('with the remaining reference measurements.', 136)
    ]
  }
  const caption = {
    lines: [page.lines[0].text, page.lines[2].text, page.lines[4].text],
    rect: [50, 98, 158, 146]
  }
  const before = structuredClone(page)
  const result = nativeCaptionLiteralFragments(page, caption)
  expect(result?.lines[0]).toBe(`${page.lines[0].text}⁻²`)
  expect(result?.lines[1]).toBe(`${page.lines[2].text}⁻³`)
  expect(page).toEqual(before)
  page.lines[1].y = 108
  page.lines[3].y = 126
  expect(nativeCaptionLiteralFragments(page, caption)?.lines[0]).toBe(
    `${page.lines[0].text} ${minus}2`
  )
})

it('preserves every physical prose row when first-row scripts connect adjacent ink boxes', () => {
  const page = input()[0]
  const before = structuredClone(page)
  const caption = findCaptionCandidates([page])[0]
  expect(caption.lines).toHaveLength(9)
  expect(caption.lines[0]).toContain('bridge W top q')
  expect(caption.lines[1]).toBe(page.lines[3].text)
  expect(caption.lines[3]).toContain('bridge W top xy')
  expect(caption.lines.at(-1)).toBe('ending the caption.')
  expect(page).toEqual(before)
})

it('retains a slightly inset terminal caption row with independent text background boxes', () => {
  const page = input()[1]
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.map((l: { text: string }) => l.text)
  )
  expect(page).toEqual(before)
})

it.each(['duplicate-parent', 'detached-script', 'preceding-prose'])(
  'does not recover a complete paragraph with unproved fragment ownership: %s',
  (missing) => {
    const page = input()[0]
    const caption = findCaptionCandidates([page])[0]
    if (missing === 'duplicate-parent')
      page.lines.push({ ...page.lines[0], y: page.lines[0].y + 0.1 })
    if (missing === 'detached-script') page.lines[1].x += page.lines[0].fontSize
    if (missing === 'preceding-prose')
      page.lines.push({
        ...page.lines[0],
        text: 'An independent neighboring prose row.',
        y: page.lines[0].y - page.lines[0].fontSize * 0.2
      })
    expect(nativeCaptionLiteralFragments(page, caption)).toBeUndefined()
  }
)

it.each(['boxes', 'font', 'closure', 'completed-caption', 'indent'])(
  'requires independent evidence for an inset caption tail: %s',
  (missing) => {
    const page = input()[1]
    if (missing === 'boxes') page.graphicsBounds = []
    if (missing === 'font') page.lines[3].fontSize += 1
    if (missing === 'closure') page.lines[3].text = 'an unfinished neighboring source paragraph'
    if (missing === 'completed-caption') page.lines[2].text += '.'
    if (missing === 'indent') page.lines[3].x += 20
    expect(findCaptionCandidates([page])[0].lines).not.toContain(page.lines[3].text)
  }
)

it.each([0, 1])('preserves source order and scale for owned baselines (%s)', (index) => {
  const page = input()[index]
  const expected = findCaptionCandidates([page])[0].lines
  page.width *= 1.7
  page.height *= 1.7
  for (const line of page.lines)
    for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= 1.7
  page.lines.reverse()
  expect(findCaptionCandidates([page])[0].lines).toEqual(expected)
})

it.each(['Fig. 1 (i)-(j).', 'Figure 2 (a)–(b).'])(
  'uses native context to distinguish panel-range prose from a real graphic caption (%s)',
  (label) => {
    const text = `${label} The shared record is formed by combining the measurements.`
    expect(captionKind(text)).toBe('figure')
    const line = (
      text: string,
      y: number
    ): {
      text: string
      x: number
      y: number
      width: number
      height: number
      fontSize: number
    } => ({
      text,
      x: 100,
      y,
      width: 400,
      height: 10,
      fontSize: 10
    })
    const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      lines: [
        line(
          'The preceding source paragraph describes the independent measurement procedure.',
          100
        ),
        line('The same paragraph continues through the source records and measured fields,', 112),
        line(text, 124)
      ],
      graphicsBounds: [] as { kind: string; normalizedRect: number[] }[]
    }
    expect(findCaptionCandidates([page])).toHaveLength(0)
    page.graphicsBounds = [
      { kind: 'path', normalizedRect: [100 / 600, 90 / 800, 500 / 600, 122 / 800] }
    ]
    expect(findCaptionCandidates([page])).toHaveLength(0)
    page.graphicsBounds = [
      { kind: 'image', normalizedRect: [100 / 600, 70 / 800, 500 / 600, 110 / 800] }
    ]
    expect(findCaptionCandidates([page])[0].lines[0]).toBe(text)
    page.graphicsBounds[0].normalizedRect[3] = 90 / 800
    expect(findCaptionCandidates([page])[0].lines[0]).toBe(text)
    page.graphicsBounds = []
    page.lines[1].text += '.'
    expect(findCaptionCandidates([page])[0].lines[0]).toBe(text)
    expect(captionKind(label.replace(/\.$/, ':') + ' Independent reference measurements.')).toBe(
      'figure'
    )
    expect(captionKind(`${label} Independent reference measurements.`)).toBe('figure')
    expect(captionKind('Figure 1. (a)–(b). The shared record is formed from the source.')).toBe(
      'figure'
    )
  }
)
