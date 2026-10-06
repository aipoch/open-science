import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { captionKind, findCaptionCandidates, groupPageLines } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { nativeCaptionOwnedInlineFragments } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-caption-script-order.mjs'))
    .href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-caption-paragraph-layouts.jsonl'
    )
  )

it.each(['B', 'C', 'D', 'E', 'G', 'H', 'T', 'Z'])(
  'recognizes a formal appendix figure %s while rejecting prose',
  (prefix) => {
    expect(captionKind(`Figure ${prefix}2: Independent measured records.`)).toBe('figure')
    expect(captionKind(`Figure ${prefix}2 shows the independent measured records.`)).toBeUndefined()
    expect(
      captionKind(`Figure ${prefix}2 and 3. For this condition, the value is larger.`)
    ).toBeUndefined()
  }
)

it('keeps a repeatedly aligned algorithm column out of native caption lines', () => {
  const page = input()[0]
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.slice(0, 3).map((l: { text: string }) => l.text)
  )
  expect(groupPageLines(page).filter((l: { text: string }) => /end for/.test(l.text))).toHaveLength(
    3
  )
  expect(page).toEqual(before)
})

it('retains a uniform smaller-font tail without taking neighboring body prose', () => {
  const page = input()[1]
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.slice(0, 5).map((l: { text: string }) => l.text)
  )
})

it.each(['graphic', 'font', 'closure'])(
  'requires independent %s evidence for smaller type',
  (missing) => {
    const page = input()[1]
    if (missing === 'graphic') page.graphicsBounds = []
    if (missing === 'font') page.lines[2].fontSize += 0.8
    if (missing === 'closure') page.lines[4].text = 'while the source remains unfinished'
    expect(findCaptionCandidates([page])[0].lines).toEqual([page.lines[0].text])
  }
)

it('retains an unfinished caption followed by a short centered literal noun tail', () => {
  const page = input()[2]
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.slice(0, 2).map((l: { text: string }) => l.text)
  )
})

it.each(['closure', 'graphic', 'alignment', 'font'])(
  'does not append an unproved centered tail: %s',
  (missing) => {
    const page = input()[2]
    if (missing === 'closure') page.lines[0].text += '.'
    if (missing === 'graphic') page.graphicsBounds = []
    if (missing === 'alignment') page.lines[1].x += 10
    if (missing === 'font') page.lines[1].fontSize += 1
    expect(findCaptionCandidates([page])[0].lines).toEqual([page.lines[0].text])
  }
)

it('retains an explicit centered final panel clause at a following-page caption', () => {
  const page = input()[3]
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.slice(0, 2).map((l: { text: string }) => l.text)
  )
  page.lines[0].text = page.lines[0].text.replace('Middle:', 'Observed:')
  expect(findCaptionCandidates([page])[0].lines).toEqual([page.lines[0].text])
})

it('keeps distinct literal prose baselines when raised operators connect their ink boxes', () => {
  const page = input()[4]
  const before = structuredClone(page)
  const lines = findCaptionCandidates([page])[0].lines as string[]
  expect(lines).toHaveLength(6)
  expect(lines[2]).toContain('defined in Ref.')
  expect(lines[2]).toContain('The source total uses an independently measured average')
  expect(lines[2]).not.toContain('over these sites')
  expect(lines[3]).toContain(
    'over these sites ( ∑ aiBi/ ∑ ai), retaining the literal multiplicity:'
  )
  expect(page).toEqual(before)
})

it('attaches a shared-edge script only to its uniquely closest owned prose row', () => {
  const first = {
    text: 'Figure 1: The first quantity x',
    x: 100,
    y: 500,
    width: 160,
    height: 10,
    fontSize: 10
  }
  const second = { ...first, text: 'The second quantity y is independently measured.', y: 512 }
  const script = { ...first, text: 'n', x: 260, y: 511, width: 4, height: 7, fontSize: 7 }
  const page = { pageNumber: 1, width: 600, height: 800, lines: [first, second, script] }
  const before = structuredClone(page)
  const caption = { page: 1, lines: [first.text, second.text], rect: [100, 500, 264, 522] }
  const owned = [first, second].map((l) => ({ ...l, right: l.x + l.width, bottom: l.y + l.height }))
  expect(nativeCaptionOwnedInlineFragments(page, caption, owned)?.lines).toEqual([
    first.text,
    second.text + ' n'
  ])
  expect(page).toEqual(before)
})

it('retains a native indented italic title between a centered table label and its opening', () => {
  const page = input()[5]
  const rules = new Map([
    [
      1,
      [
        [100, 535, 500, 535],
        [100, 570, 500, 570]
      ]
    ]
  ])
  expect(findCaptionCandidates([page], rules)[0].lines).toEqual(
    page.lines.slice(0, 3).map((l: { text: string }) => l.text)
  )
  expect(findCaptionCandidates([page])[0].lines).toEqual([page.lines[0].text])
})

it.each([0, 1, 2, 3, 4, 5])('is invariant under native source order and scale (%s)', (index) => {
  const page = input()[index]
  const rules =
    index === 5
      ? new Map([
          [
            1,
            [
              [100, 535, 500, 535],
              [100, 570, 500, 570]
            ]
          ]
        ])
      : new Map()
  const expected = findCaptionCandidates([page], rules)[0].lines
  page.width *= 1.7
  page.height *= 1.7
  for (const line of page.lines)
    for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= 1.7
  page.lines.reverse()
  const scaled = new Map(
    [...rules].map(([p, rs]) => [p, rs.map((r: number[]) => r.map((v) => v * 1.7))])
  )
  expect(findCaptionCandidates([page], scaled)[0].lines).toEqual(expected)
})

it('retains a centered graphic caption with independently inset physical rows', () => {
  const page = input()[6]
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.slice(0, 3).map((l: { text: string }) => l.text)
  )
  expect(page).toEqual(before)
})

it.each(['graphic', 'alignment', 'font', 'gap', 'closure', 'independent-caption'])(
  'requires complete source evidence for centered continuation (%s)',
  (missing) => {
    const page = input()[6]
    if (missing === 'graphic') page.graphicsBounds = []
    if (missing === 'alignment') page.lines[1].x += 10
    if (missing === 'font') page.lines[1].fontSize += 1
    if (missing === 'gap') page.lines[1].y += 20
    if (missing === 'closure') page.lines[2].text = 'The terminal source remains unfinished'
    if (missing === 'independent-caption')
      page.lines[1].text = 'Figure 9. Independently measured second panel.'
    expect(findCaptionCandidates([page])[0].lines).toEqual([page.lines[0].text])
  }
)

it('keeps a numbered cross-reference within an unfinished owning caption', () => {
  const page = input()[7]
  const captions = findCaptionCandidates([page])
  expect(captions).toHaveLength(1)
  expect(captions[0].lines).toEqual(page.lines.slice(0, 5).map((l: { text: string }) => l.text))
})

it.each(['graphic', 'closure', 'font', 'leading', 'new-plate'])(
  'keeps a following numbered caption separate without source ownership (%s)',
  (missing) => {
    const page = input()[7]
    if (missing === 'graphic') page.graphicsBounds = []
    if (missing === 'closure')
      page.lines[2].text = 'and the corresponding observations remain complete.'
    if (missing === 'font') page.lines[3].fontSize += 1
    if (missing === 'leading') page.lines[3].y += 10
    if (missing === 'new-plate')
      page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.1, 0.30125, 0.85, 0.3075] })
    expect(
      findCaptionCandidates([page]).some((c: { lines: string[] }) =>
        c.lines[0].startsWith('Figure 8.')
      )
    ).toBe(true)
  }
)

it.each(['AB', 'SM', 'ABC'])(
  'classifies a punctuated multi-letter figure ordinal %s literally',
  (prefix) => {
    expect(captionKind(`Figure ${prefix}2: Independently measured source panels.`)).toBe('figure')
    expect(
      captionKind(`Figure ${prefix}2 shows the independently measured source panels.`)
    ).toBeUndefined()
    expect(
      captionKind(`Figure ${prefix}2: we show the independently measured source panels.`)
    ).toBeUndefined()
  }
)

it('keeps body references after native extended script boxes out of caption ownership', () => {
  expect(findCaptionCandidates([input()[8]])).toEqual([])
})

it.each(['parent-cue', 'font', 'spacing', 'indent'])(
  'requires matching body context for an appendix reference (%s)',
  (missing) => {
    const page = input()[8]
    page.lines = page.lines.slice(2)
    if (missing === 'parent-cue')
      page.lines[0].text = 'A separately measured complete distribution remains available.'
    if (missing === 'font') page.lines[0].fontSize += 1
    if (missing === 'spacing') page.lines[1].y += 15
    if (missing === 'indent') page.lines[0].x += 15
    expect(
      findCaptionCandidates([page]).some((c: { lines: string[] }) => c.lines[0] === 'Fig. B.2.')
    ).toBe(true)
  }
)

it('keeps serial figure pointers after an indented paragraph opener as body', () => {
  expect(findCaptionCandidates([input()[9]])).toEqual([])
})

it.each(['parent-cue', 'font', 'spacing'])(
  'preserves a serial figure title without its explicit paragraph cue (%s)',
  (missing) => {
    const page = input()[9]
    if (missing === 'parent-cue')
      page.lines[0].text = 'A separate complete observation remains available.'
    if (missing === 'font') page.lines[0].fontSize += 1
    if (missing === 'spacing') page.lines[1].y += 15
    expect(findCaptionCandidates([page])).toHaveLength(1)
  }
)

it.each(['solidifies', 'connects', 'serves two purposes'])(
  'keeps the literal finite-verb figure reference as prose (%s)',
  (verb) => {
    expect(captionKind(`Figure 9 ${verb} the independently measured observations.`)).toBeUndefined()
    expect(captionKind('Figure 9. Connections between independently measured observations.')).toBe(
      'figure'
    )
  }
)
