import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  baseline: number,
  width: number,
  font = 10,
  fontName = 'body'
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  fontName,
  dir: 'ltr',
  hasEOL: true,
  transform: [font, 0, 0, font, x, 800 - baseline]
})
const opening = (
  options: {
    cap?: string
    size?: number
    x?: number
    baseline?: number
    rows?: number
    foreign?: boolean
    intervening?: boolean
  } = {}
): PdfLayoutTextItem[] => {
  const runs = [
    item(options.cap ?? 'S', 40, options.baseline ?? 144, 20, options.size ?? 40, 'initial')
  ]
  runs[0].hasEOL = false
  if (options.intervening) runs.push(item('Independent figure label.', 350, 300, 130))
  const rows = [
    'cience brings numerical tools to researchers and practitioners',
    'building reliable programs for scientific data and analysis',
    'with libraries and reusable methods that support complete'
  ]
  for (let n = 0; n < (options.rows ?? 3); n++)
    runs.push(
      item(
        rows[n],
        options.x ?? 60,
        120 + n * 12,
        230,
        10,
        options.foreign && n === 1 ? 'foreign' : 'body'
      )
    )
  runs.push(item('workflows across many fields and areas of research.', 40, 156, 250))
  return runs
}
const extract = (items: PdfLayoutTextItem[]): ReturnType<typeof groupPdfTranslationPages> =>
  groupPdfTranslationPages({ pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }] })

test('an inset drop cap belongs to the first word and its full paragraph', () => {
  const items = opening(),
    before = structuredClone(items),
    result = extract(items)
  const paragraph = result.units.find((unit) => unit.source.startsWith('Science brings'))
  assert.ok(paragraph, JSON.stringify(result.units))
  assert.ok(paragraph.source.endsWith('areas of research.'))
  assert.equal(paragraph.items.length, 5)
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, items.length)
  assert.deepEqual(items, before, 'native transforms and original strings stay unchanged')
  assert.ok(!result.units.some((unit) => unit.source.startsWith('Sbuilding')))
})

test.each([
  { name: 'a numeral', cap: '5' },
  { name: 'a Greek variable', cap: 'Σ' },
  { name: 'an ordinary first-letter size', size: 10 },
  { name: 'an oversized title', size: 70 },
  { name: 'an unrelated horizontal initial', x: 90 },
  { name: 'an unrelated baseline', baseline: 180 },
  { name: 'one unproven inset row', rows: 1 },
  { name: 'two unproven inset rows', rows: 2 },
  { name: 'a different inset typeface', foreign: true },
  { name: 'intervening native content', intervening: true }
])('$name does not gain drop-cap paragraph ownership', (options) => {
  const result = extract(opening(options))
  assert.ok(
    !result.units.some(
      (unit) => unit.source.startsWith('Science brings') && unit.items.length === 5
    )
  )
})

test('retains separately grouped source runs of a two-row small-cap opening', () => {
  const runs = [
    item('S', 40, 132, 20, 30, 'initial'),
    item('IGNAL interfaces use experimental obser-', 61, 120, 229),
    item('vations to calibrate external devices, such as artifi-', 61, 132, 229),
    item('cial', 40, 144, 22),
    item('limbs', 68, 144, 22),
    item('and', 96, 144, 15),
    item('computers,', 117, 144, 44),
    item('providing', 167, 144, 39),
    item('stable', 212, 144, 30),
    item('operation', 248, 144, 42),
    item('for participants learning how to use the new devices.', 40, 156, 250)
  ]
  runs[0].hasEOL = false
  for (const run of runs.slice(3, 9)) run.hasEOL = false
  const sourceKeys = new Set(runs.slice(0, -1).map((_, i) => `1:${i}`))
  const result = extract(runs)
  assert.deepEqual(
    new Set(result.units.filter((unit) => unit.sourceOnly).flatMap((unit) => unit.items)),
    sourceKeys
  )
  assert.equal(result.units.find((unit) => unit.items.includes('1:10'))?.sourceOnly, undefined)

  runs[2].fontName = 'unrelated'
  assert.equal(
    extract(runs).units.find((unit) => unit.items.includes('1:0'))?.sourceOnly,
    undefined
  )
})

test.each(['complete', 'other inset font', 'no second-line wrap', 'return still inset'])(
  'retains only the unsafe first-row owner of a split two-row drop-cap opening: %s',
  (shape) => {
    const words = ['ARGE', 'calibrated', 'arrays', 'measure', 'several', 'independent', 'signals']
    const runs = [
      item('L', 40, 132, 20, 30, 'initial'),
      ...words.map((word, i) => ({
        ...item(word, 61 + i * 35, 120, i === words.length - 1 ? 19 : 30),
        hasEOL: i === words.length - 1
      })),
      item(
        shape === 'no second-line wrap'
          ? 'during normal field tests, with signal levels varying'
          : 'during normal field tests, with signal levels vary-',
        61,
        132,
        229,
        10,
        shape === 'other inset font' ? 'foreign' : 'body'
      ),
      item(
        'ing with temperature and various input conditions.',
        shape === 'return still inset' ? 61 : 40,
        144,
        shape === 'return still inset' ? 229 : 250
      ),
      item('We record the results and combine all observations.', 40, 156, 250)
    ]
    runs[0].hasEOL = false
    const result = extract(runs)
    const opening = result.units.find((unit) => unit.items.includes('1:0'))
    assert.equal(opening?.sourceOnly, shape === 'complete' ? true : undefined)
    const continuation = result.units.find((unit) => unit.items.includes('1:9'))
    assert.ok(continuation && !continuation.sourceOnly)
    assert.deepEqual(
      result.units.flatMap((unit) => unit.items).sort(),
      runs.map((_, index) => `1:${index}`).sort()
    )
  }
)

test.each([true, false])(
  'joins a split small-cap opening only with a matching margin return: %s',
  (returns) => {
    const runs = [
      item('S', 40, 133, 19, 30, 'initial'),
      item('PECTRAL', 60, 120, 52),
      item('imaging', 118, 120, 31),
      item('methods', 156, 120, 38),
      item('reveal', 201, 120, 28),
      item('hidden', 236, 120, 29),
      item('features', 272, 120, 28),
      item('across a series of controlled physical conditions', 60, 132, 240),
      item(
        'during a gradual change in the measured signal.',
        returns ? 40 : 60,
        144,
        returns ? 260 : 240
      )
    ]
    for (const run of runs.slice(0, 6)) run.hasEOL = false
    const unchanged = structuredClone(runs)
    const owner = extract(runs).units.find((unit) => unit.items.includes('1:0'))
    assert.ok(owner)
    if (returns) {
      assert.equal(
        owner.source,
        'SPECTRAL imaging methods reveal hidden features across a series of controlled physical conditions during a gradual change in the measured signal.'
      )
      assert.equal(owner.sourceOnly, undefined)
      assert.deepEqual(
        owner.items,
        runs.map((_, index) => `1:${index}`)
      )
    } else {
      assert.ok(!owner.items.includes('1:7'))
    }
    assert.deepEqual(runs, unchanged)
  }
)

test('joins a bundled small-cap opening to its native initial without an inserted word space', () => {
  const runs = [
    { ...item('V', 60, 132, 20, 30, 'initial'), hasEOL: false },
    item('ISUAL systems combine several available signals in multi-', 81, 120, 249),
    item('modal experiments recover useful evidence from independent observations', 81, 132, 249),
    item('these methods remain useful across several controlled settings.', 60, 144, 270),
    item('A separate neighboring paragraph starts below the completed opening.', 60, 180, 270)
  ]
  const result = extract(runs)
  const paragraph = result.units.find((unit) => unit.items.includes('1:0'))!
  assert.ok(paragraph.source.startsWith('VISUAL systems'), paragraph.source)
  assert.ok(paragraph.source.includes('multi-modal experiments'), paragraph.source)
  assert.ok(!paragraph.source.includes('V ISUAL'))
  assert.deepEqual(paragraph.items, ['1:0', '1:1', '1:2', '1:3'])
  assert.equal(result.units.find((unit) => unit.items.includes('1:4'))?.items.length, 1)
})

test.each(['inset', 'foreign row'])(
  'joins a last-painted initial with its native opening: %s',
  (shape) => {
    const text = 'ingle entry measurements help calibration teams'
    const rows = [
      text,
      'compare independent signals under controlled conditions',
      'with calibrated references and repeated observations',
      'to confirm the result across multiple sampling periods',
      'and characterize changes across varied input conditions',
      'for stable readings during routine measurement.'
    ].flatMap((content, i) => [
      { ...item('', i === 5 ? 40 : 67, 120 + i * 11.4, 0), height: 0 },
      {
        ...item(content, i === 5 ? 40 : 67, 120 + i * 11.4, i === 5 ? 257 : 230),
        hasEOL: false,
        fontName: i === 2 && shape === 'foreign row' ? 'foreign' : 'body'
      }
    ])
    const runs = [
      { ...item('I. INTRODUCTION', 140, 104, 80), hasEOL: false },
      ...rows,
      { ...item('', 40, 167, 0, 48.5), height: 0 },
      { ...item('S', 40, 155.9, 27, 48.5), hasEOL: false }
    ]
    const result = extract(runs.map((run) => ({ ...run, fontVertical: false })))
    const start = result.units.find((unit) => unit.items.includes('1:2'))!
    if (shape === 'inset') {
      assert.ok(start.source.startsWith('Single entry measurements'), start.source)
      assert.ok(start.source.endsWith('during routine measurement.'), start.source)
      assert.equal(start.sourceOnly, undefined)
      assert.equal(start.items.length, 7)
    } else {
      assert.ok(!start.source.startsWith('Single entry measurements'), start.source)
    }
    assert.deepEqual(
      result.units.flatMap((unit) => unit.items).sort(),
      runs.flatMap((run, index) => (run.str.trim() ? [`1:${index}`] : [])).sort()
    )
  }
)
