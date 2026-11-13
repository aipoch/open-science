import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { readPdfFixture } from './read-fixture'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkerResult } from '../src/worker-result.js'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeOverlayMathRecords, nativeMathOverlaySerialization } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-math-field-record-grid.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture('test/fixtures/source-grids/wrapped-math-with-zero-advance-negation.jsonl')

it('keeps the negation on its proved equality and preserves complete wrapped fields', () => {
  const f = input()
  const original = JSON.stringify(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[3][0].replace(/\s/gu, '').normalize('NFC')).toBe('Qq≠0')
  expect(r.grid[3][1]).toMatch(/^ξ/)
  expect(r.grid[2][0]).toContain('continued condition')
  expect(r.grid[2][1]).toContain('continued expression')
  expect(r.unassigned).toEqual([])
  const owners = r.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems ?? [])
  expect(owners).toEqual(
    expect.arrayContaining(f.tokens.map((i: ReturnType<typeof JSON.parse>) => i.sourceItem))
  )
  expect(owners).toHaveLength(f.tokens.length)
  expect(
    new Set(owners.map((o: ReturnType<typeof JSON.parse>) => `${o.pageNumber}:${o.index}`)).size
  ).toBe(f.tokens.length)
  for (const cell of r.cells) {
    if (cell.textRuns)
      expect(cell.textRuns.map((run: { text: string }) => run.text).join('')).toBe(cell.text)
  }
  expect(JSON.stringify(f)).toBe(original)
  expect(f.tokens.find((i: ReturnType<typeof JSON.parse>) => i.text === '\u0338').rect[2]).toBe(70)
})

type Input = ReturnType<typeof JSON.parse>
const mark = (f: Input): Input => f.tokens.find((i: Input) => i.text === '\u0338')
const anchor = (f: Input): Input =>
  f.tokens.find((i: Input) => i.text === '= 0' && i.baseline === 116)

it.each<[string, (f: Input) => void]>([
  [
    'a positive-advance slash',
    (f) => {
      mark(f).rect[2] += 1
    }
  ],
  [
    'another combining mark',
    (f) => {
      const m = mark(f)
      m.text = m.sourceItem.text = '\u0301'
    }
  ],
  [
    'a displaced overlay',
    (f) => {
      mark(f).rect[0] += 1
      mark(f).rect[2] += 1
    }
  ],
  [
    'a different overlay baseline',
    (f) => {
      mark(f).baseline -= 1
      mark(f).rect[1] -= 1
      mark(f).rect[3] -= 1
    }
  ],
  [
    'a differently sized overlay',
    (f) => {
      mark(f).height = 9
      mark(f).rect[1] += 1
    }
  ],
  [
    'an unfamiliar relation',
    (f) => {
      const a = anchor(f)
      a.text = a.sourceItem.text = '< 0'
    }
  ],
  [
    'two overlaid operators',
    (f) => {
      const a = structuredClone(anchor(f))
      a.sourceItem.index = 1000
      f.tokens.push(a)
    }
  ],
  [
    'duplicate negation ink',
    (f) => {
      const m = structuredClone(mark(f))
      m.sourceItem.index = 1000
      f.tokens.push(m)
    }
  ],
  [
    'a source segment alias outside the frame',
    (f) => {
      const m = mark(f)
      f.tokens.push({
        text: 'other',
        rect: [400, 150, 410, 160],
        horizontal: true,
        height: 10,
        baseline: 160,
        sourceSegment: { ...m.sourceItem, start: 0, end: 1 }
      })
    }
  ],
  [
    'a nested original alias outside the frame',
    (f) => {
      f.tokens.push({
        text: 'other',
        rect: [400, 150, 410, 160],
        horizontal: true,
        height: 10,
        baseline: 160,
        sourceTokens: [structuredClone(mark(f))]
      })
    }
  ],
  [
    'a mark with competing nested ownership',
    (f) => {
      mark(f).sourceToken = structuredClone(anchor(f))
    }
  ],
  [
    'a source-original text conflict',
    (f) => {
      mark(f).sourceItem.text = '/'
    }
  ],
  [
    'a missing closing rule',
    (f) => {
      f.rules.pop()
    }
  ],
  [
    'an internal vertical divider',
    (f) => {
      f.rules.push([100, 23, 100, 124])
    }
  ],
  [
    'a missing result anchor',
    (f) => {
      f.tokens = f.tokens.filter((i: Input) => i.text !== 'Claim 78')
    }
  ],
  [
    'a continuation with a new relation',
    (f) => {
      const i = f.tokens.find((i: Input) => i.text === 'continued condition')
      i.text = 'q = 1'
      i.sourceItem.text = i.text
    }
  ],
  [
    'an incomplete paired continuation',
    (f) => {
      f.tokens = f.tokens.filter((i: Input) => i.text !== 'continued expression')
    }
  ],
  [
    'a source word crossing the gutter',
    (f) => {
      f.tokens.find((i: Input) => i.text === 'continued condition').rect[2] = 150
    }
  ],
  [
    'a foreign result-column overlay',
    (f) => {
      mark(f).rect[0] = mark(f).rect[2] = 310
    }
  ]
])('declines %s without formatting or mutating source ink', (_name, mutate) => {
  const f = input()
  mutate(f)
  const original = JSON.stringify(f)
  expect(recoverNativeOverlayMathRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  expect(nativeMathOverlaySerialization(f.tokens, undefined)).toBe(f.tokens)
  expect(JSON.stringify(f)).toBe(original)
})

it('retains the literal unsupported mark in the existing fallback diagnostics', () => {
  const f = input()
  const m = mark(f)
  m.text = m.sourceItem.text = '\u0301'
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.unassigned).toContain('\u0301')
  expect(r.grid.flat().join('')).not.toContain('\u0338')
})

it('transports every original source claim through the existing public result contract', async () => {
  const f = input(),
    original = JSON.stringify(f),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules),
    root = await mkdtemp(join(tmpdir(), 'pdf-math-overlay-')),
    identity = {
      extractionId: 'overlay-test',
      engineFingerprint: 'a'.repeat(64),
      sourceChecksum: 'b'.repeat(64),
      sourceSizeBytes: 100,
      requestedPages: [1]
    }
  try {
    await mkdir(join(root, 'thumbnails'))
    await writeFile(
      join(root, 'thumbnails/table.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
        'base64'
      )
    )
    await writeFile(
      join(root, 'structure.json'),
      JSON.stringify({
        sourceSha256: identity.sourceChecksum,
        pageCount: 1,
        requestedPages: [1],
        processedPages: [1],
        pages: [{ page: 1, width: 400, height: 160, rotation: 0 }],
        figures: [],
        navigation: { entries: [] },
        tables: [
          {
            ...r,
            id: 'table',
            page: 1,
            region: [0.075, 0.14375, 0.875, 0.775],
            thumbnail: 'thumbnails/table.png',
            sourceViewport: { width: 400, height: 160 }
          }
        ]
      })
    )
    const result = await readWorkerResult(root, identity, new Map())
    const table = result.elements[0].table!
    const claims = table.cells.flatMap((c) => c.sourceItems ?? [])
    expect(claims).toHaveLength(f.tokens.length)
    expect(claims).toEqual(expect.arrayContaining(f.tokens.map((i: Input) => i.sourceItem)))
    const condition = table.cells.find((c) => c.row === 3 && c.column === 0)!
    expect(condition.text.replace(/\s/gu, '').normalize('NFC')).toBe('Qq≠0')
    expect(condition.sourceItems).toContainEqual(mark(f).sourceItem)
    expect(condition.regions).toContainEqual({
      page: 1,
      x: 70 / 400,
      y: 106 / 160,
      width: 90 / 400 - 70 / 400,
      height: 10 / 160
    })
    expect(table.cells.flatMap((c) => c.regions)).toHaveLength(f.tokens.length - 1)
    expect(table.unassignedText).toEqual([])
    expect(JSON.stringify(f)).toBe(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not suppress an overlay when its proved equality is absent from the serialization packet', () => {
  const f = input(),
    m = mark(f)
  const proof = recoverNativeOverlayMathRecords(f.table, f.tokens, f.captions, f.rules)
  expect(nativeMathOverlaySerialization([m], proof.combiningOperators)).toEqual([m])
})

it.each([0.5, 2])('keeps the complete proof at uniform scale %s', (scale) => {
  const f = input()
  f.table.cropRect = f.table.cropRect.map((x: number) => x * scale)
  for (const i of f.table.structure.objects) i.rect = i.rect.map((x: number) => x * scale)
  for (const i of f.tokens) {
    i.rect = i.rect.map((x: number) => x * scale)
    i.baseline *= scale
    i.height *= scale
  }
  for (const c of f.captions) c.rect = c.rect.map((x: number) => x * scale)
  f.rules = f.rules.map((r: number[]) => r.map((x: number) => x * scale))
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[3][0].replace(/\s/gu, '').normalize('NFC')).toBe('Qq≠0')
  expect(r.unassigned).toEqual([])
})
