import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { comparePdfStructureBatches } from './pdf-structure-regression.mjs'

let directory: string
const batches = [{ manifest: 'manifest.json', before: 'before', after: 'after', batchSize: 1 }]
const source = Buffer.from('%PDF-1.7 sample source')
const sourceSha256 = createHash('sha256').update(source).digest('hex')
const record = {
  thumbnail: 'crop.png',
  page: 1,
  grid: [['0']],
  cells: [{ text: '0', rowSpan: 1, colSpan: 1, sourceRects: [[1, 2, 3, 4]] }],
  notes: [{ text: 'Source: Example.' }]
}
const baseline = {
  sourceSha256,
  pageCount: 1,
  processedPages: [1],
  figures: [],
  tables: [record],
  algorithms: []
}
function writeCandidate(value: object): void {
  writeFileSync(join(directory, 'after-doc-1/structure.json'), JSON.stringify(value))
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'pdf-regression-'))
  writeFileSync(join(directory, 'source.pdf'), source)
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify([{ id: 'doc', total: 1, path: 'source.pdf' }])
  )
  for (const prefix of ['before', 'after']) {
    mkdirSync(join(directory, `${prefix}-doc-1`))
    writeFileSync(
      join(directory, `${prefix}-doc-1/crop.png`),
      createCanvas(2, 2).toBuffer('image/png')
    )
    writeFileSync(join(directory, `${prefix}-doc-1/structure.json`), JSON.stringify(baseline))
  }
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('compares every expected page while ignoring run fingerprints', async () => {
  writeCandidate({ ...baseline, extractorFingerprint: 'new-version' })
  expect(await comparePdfStructureBatches(batches, directory)).toEqual([
    {
      manifest: 'manifest.json',
      documents: 1,
      pages: 1,
      imagesCompared: 1,
      unrenderedRecords: 0,
      differences: []
    }
  ])
})

it.each([
  ['cell text', { ...record, cells: [{ ...record.cells[0], text: '0 (' }] }],
  ['merged cells', { ...record, cells: [{ ...record.cells[0], colSpan: 2 }] }],
  ['source geometry', { ...record, cells: [{ ...record.cells[0], sourceRects: [] }] }],
  ['table notes', { ...record, notes: [] }]
])('reports changed %s with its document and page', async (_, changed) => {
  writeCandidate({ ...baseline, tables: [changed] })
  expect((await comparePdfStructureBatches(batches, directory))[0].differences).toEqual([
    { file: 'doc', page: 1, kind: 'tables', before: [record], after: [changed] }
  ])
})

it('reports a missing figure', async () => {
  const figure = { thumbnail: 'crop.png', page: 1, region: [0, 0, 1, 1] }
  writeFileSync(
    join(directory, 'before-doc-1/structure.json'),
    JSON.stringify({ ...baseline, figures: [figure] })
  )
  expect((await comparePdfStructureBatches(batches, directory))[0].differences[0]).toMatchObject({
    page: 1,
    kind: 'figures',
    before: [figure],
    after: []
  })
})

it.each([[], [1, 1], [2]])(
  'rejects incomplete or duplicate page coverage: %j',
  async (processedPages) => {
    writeCandidate({ ...baseline, processedPages })
    await expect(comparePdfStructureBatches(batches, directory)).rejects.toThrow(
      'Incomplete page coverage'
    )
  }
)

it('fails instead of silently skipping a missing batch', async () => {
  rmSync(join(directory, 'after-doc-1/structure.json'))
  await expect(comparePdfStructureBatches(batches, directory)).rejects.toThrow('ENOENT')
})

it('rejects an empty manifest', async () => {
  writeFileSync(join(directory, 'manifest.json'), '[]')
  await expect(comparePdfStructureBatches(batches, directory)).rejects.toThrow(
    'must contain documents'
  )
})

it('returns a failing CLI exit status for changed output', async () => {
  writeCandidate({ ...baseline, tables: [] })
  const config = join(directory, 'config.json')
  writeFileSync(config, JSON.stringify({ batches }))
  const result = spawnSync(process.execPath, [
    resolve('scripts/pdf-structure-regression.mjs'),
    config,
    join(directory, 'report.json')
  ])
  expect(result.status).toBe(1)
  expect(result.stdout.toString()).toContain('"differences": 2')
})

it.each([undefined, '0'.repeat(64)])(
  'rejects missing or mismatched source hashes: %s',
  async (hash) => {
    writeCandidate({ ...baseline, sourceSha256: hash })
    await expect(comparePdfStructureBatches(batches, directory)).rejects.toThrow(
      'Source PDF hash mismatch'
    )
  }
)

it('rejects stale outputs after the source PDF changes', async () => {
  writeFileSync(join(directory, 'source.pdf'), 'Different source')
  await expect(comparePdfStructureBatches(batches, directory)).rejects.toThrow(
    'Source PDF hash mismatch'
  )
})

it('rejects a manifest that omits source document pages', async () => {
  writeCandidate({ ...baseline, pageCount: 2 })
  await expect(comparePdfStructureBatches(batches, directory)).rejects.toThrow(
    'Document page count mismatch'
  )
})

it('resolves legacy source paths from the configured source root', async () => {
  mkdirSync(join(directory, 'manifests'))
  writeFileSync(
    join(directory, 'manifests/list.json'),
    JSON.stringify([{ id: 'doc', path: 'source.pdf', total: 1 }])
  )
  const result = await comparePdfStructureBatches(
    [{ ...batches[0], manifest: 'manifests/list.json', sourceRoot: '.' }],
    directory
  )
  expect(result[0].differences).toEqual([])
})

it('rejects a crop reference missing from a located figure', async () => {
  writeCandidate({ ...baseline, figures: [{ page: 1, region: [0, 0, 1, 1] }] })
  await expect(comparePdfStructureBatches(batches, directory)).rejects.toThrow(
    'Missing crop reference'
  )
})

it('detects changed pixels even when structure and crop bounds are unchanged', async () => {
  const canvas = createCanvas(2, 2)
  canvas.getContext('2d').fillRect(0, 0, 1, 1)
  writeFileSync(join(directory, 'after-doc-1/crop.png'), canvas.toBuffer('image/png'))
  const [report] = await comparePdfStructureBatches(batches, directory)
  expect(report.imagesCompared).toBe(1)
  expect(report.differences).toHaveLength(1)
  expect(report.differences[0]).toMatchObject({ file: 'doc', page: 1, kind: 'tables-images' })
})

it('ignores PNG encoding differences with identical decoded pixels', async () => {
  const original = readFileSync(join(directory, 'before-doc-1/crop.png'))
  // A valid PNG tEXt chunk with its CRC, inserted before IEND.
  const metadata = Buffer.from(
    '0000001a74455874436f6d6d656e7400616c7465726e61746520656e636f64696e67d744348b',
    'hex'
  )
  const changed = Buffer.concat([original.subarray(0, -12), metadata, original.subarray(-12)])
  expect(changed.equals(original)).toBe(false)
  writeFileSync(join(directory, 'after-doc-1/crop.png'), changed)
  expect((await comparePdfStructureBatches(batches, directory))[0].differences).toEqual([])
})

it.each(['missing', 'corrupt'])('fails on a %s crop image', async (state) => {
  const path = join(directory, 'after-doc-1/crop.png')
  if (state === 'missing') rmSync(path)
  else writeFileSync(path, 'Not a PNG')
  await expect(comparePdfStructureBatches(batches, directory)).rejects.toThrow()
})

it('reports unresolved figure records separately from compared images', async () => {
  const value = { ...baseline, figures: [{ page: 1, issue: 'no-unambiguous-adjacent-graphics' }] }
  writeCandidate(value)
  writeFileSync(join(directory, 'before-doc-1/structure.json'), JSON.stringify(value))
  const [report] = await comparePdfStructureBatches(batches, directory)
  expect(report).toMatchObject({ imagesCompared: 1, unrenderedRecords: 1, differences: [] })
})

it('replaces an old passing report with failure when a batch is missing', () => {
  const config = join(directory, 'config.json')
  const output = join(directory, 'report.json')
  writeFileSync(config, JSON.stringify({ batches }))
  writeFileSync(output, JSON.stringify({ status: 'passed', reports: [] }))
  rmSync(join(directory, 'after-doc-1/structure.json'))
  const result = spawnSync(process.execPath, [
    resolve('scripts/pdf-structure-regression.mjs'),
    config,
    output
  ])
  expect(result.status).toBe(1)
  expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ status: 'failed' })
  expect(readFileSync(output, 'utf8')).not.toContain('passed')
})
