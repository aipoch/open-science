import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const titles = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/detached-title-after-bare-table-number.jsonl'
    )
  )
it('retains complete detached manuscript titles above native table openings', () => {
  const f = titles()
  const c = findCaptionCandidates(
    f.pages,
    new Map(Object.entries(f.rules).map(([k, v]) => [Number(k), v]))
  )
  expect(c.map((c: { lines: string[] }) => c.lines.join(' '))).toEqual([
    'Table 1 Patient, Tumor, and Treatment Characteristics (n = 693).',
    'Table 2 Radiation-Related Acute Adverse Events.',
    'Table 3 Dosimetric Comparison of Organs at Risk.'
  ])
})
it.each(['missing-rule', 'prose', 'different-indent', 'wide-gap', 'no-period'])(
  'declines detached title ownership with %s',
  (variant) => {
    const f = titles()
    f.pages = f.pages.slice(1, 2)
    const p = f.pages[0],
      title = p.lines[1]
    if (variant === 'missing-rule') f.rules[p.pageNumber] = []
    if (variant === 'prose') title.text = 'Radiation-related events were reported here.'
    if (variant === 'different-indent') title.x += 30
    if (variant === 'wide-gap') title.y += 20
    if (variant === 'no-period') title.text = title.text.slice(0, -1)
    const c = findCaptionCandidates(
      f.pages,
      new Map(Object.entries(f.rules).map(([k, v]) => [Number(k), v]))
    )
    expect(c[0].lines).toEqual(['Table 2'])
  }
)
const chain = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/count-percent-table-through-captionless-intermediate-page.jsonl'
    )
  )
it('retains source caption on the first captionless count-percent continuation page', () => {
  const f = chain(),
    p = f.pages[1]
  expect(
    associateTableCaptions(p, [{ rect: [66, 65, 546, 755] }], f.captions, [], f.pages)
  ).toEqual([{ caption: f.captions[0] }])
})
it.each(['count-total', 'prose', 'competing-origin'])(
  'declines one-page continuation with %s',
  (variant) => {
    const f = chain(),
      p = f.pages[1]
    if (variant === 'count-total')
      f.pages[0].lines.find((l: { text: string }) => /Cohort-A/.test(l.text)).text =
        'Cohort-A (n = 200) Cohort-B (n = 344)'
    if (variant === 'prose')
      p.lines.push({
        text: 'Discussion begins with these results.',
        x: 108.3,
        y: 400,
        width: 300,
        height: 12,
        fontSize: 12
      })
    if (variant === 'competing-origin')
      f.captions.push({ ...f.captions[0], lines: ['Table 2. Another cohort.'] })
    expect(
      associateTableCaptions(p, [{ rect: [66, 65, 546, 755] }], f.captions, [], f.pages)[0].caption
    ).toBeUndefined()
  }
)
