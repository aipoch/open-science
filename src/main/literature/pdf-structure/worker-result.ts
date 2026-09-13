import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { readFileWithinLimit } from '../../storage/durable-json-file'
import { checkPdfStructureDecodingBudget } from '../../../shared/pdf-structure'
import {
  parsePdfStructureResult,
  type PdfStructureIdentity,
  type PdfStructureResult
} from './result'

const rect = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite()
])
const caption = z.object({ text: z.string(), rect }).optional()
const candidate = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  page: z.number().int().positive(),
  region: rect.optional(),
  thumbnail: z.string().optional(),
  caption,
  issue: z.string().optional()
})
const rawSchema = z.object({
  sourceSha256: z.string(),
  pageCount: z.number().int().positive(),
  requestedPages: z.array(z.number()),
  processedPages: z.array(z.number()),
  pages: z.array(
    z.object({
      page: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
      rotation: z.literal(0)
    })
  ),
  figures: z.array(candidate).max(128),
  tables: z
    .array(
      candidate.extend({
        captionIssue: z.string().optional(),
        sourceViewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
        grid: z.array(z.array(z.string()).max(128)).max(256),
        cells: z
          .array(
            z.object({
              row: z.number(),
              column: z.number(),
              rowSpan: z.number(),
              colSpan: z.number(),
              text: z.string(),
              sourceRects: z.array(rect)
            })
          )
          .max(2048),
        unassigned: z.array(z.string()),
        notes: z.array(z.object({ text: z.string(), rect })).optional(),
        issues: z.array(z.string())
      })
    )
    .max(32),
  navigation: z.object({
    entries: z.array(z.object({ title: z.string(), page: z.number(), depth: z.number() }))
  })
})

export const readWorkerResult = async (
  root: string,
  identity: PdfStructureIdentity,
  thumbnails: Map<string, Uint8Array>
): Promise<PdfStructureResult> => {
  // The worker has exited. Validate each path component before reading any worker output.
  for (const directory of [root, join(root, 'thumbnails')]) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Unsafe PDF output directory.')
  }
  const manifest = await lstat(join(root, 'structure.json'))
  if (!manifest.isFile() || manifest.isSymbolicLink())
    throw new Error('Unsafe PDF output manifest.')
  const input: unknown = JSON.parse(
    await readFileWithinLimit(join(root, 'structure.json'), 8 * 1024 ** 2)
  )
  checkPdfStructureDecodingBudget(input)
  const raw = rawSchema.parse(input)
  if (raw.sourceSha256 !== identity.sourceChecksum) throw new Error('PDF worker source changed.')
  for (const pages of [raw.requestedPages, raw.processedPages, raw.pages.map(({ page }) => page)]) {
    if (JSON.stringify(pages) !== JSON.stringify(identity.requestedPages))
      throw new Error('PDF worker coverage mismatch.')
  }
  let thumbnailBytes = 0
  for (const item of [...raw.figures, ...raw.tables]) {
    if (!item.region || !item.thumbnail) continue
    if (item.thumbnail !== `thumbnails/${item.id}.png`)
      throw new Error('PDF worker thumbnail identity mismatch.')
    const info = await lstat(join(root, 'thumbnails', `${item.id}.png`))
    thumbnailBytes += info.size
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 4 * 1024 ** 2 ||
      thumbnailBytes > 64 * 1024 ** 2 - manifest.size
    )
      throw new Error('PDF worker images exceed their decoding budget.')
  }
  const issues: PdfStructureResult['issues'] = [
    {
      code: 'candidate-results',
      detail:
        'Candidate extraction can miss figures, tables, captions or cell content. Verify against the PDF.'
    }
  ]
  const elements: PdfStructureResult['elements'] = []
  const inventory: PdfStructureResult['thumbnails'] = []
  const region = (
    page: number,
    box: number[],
    width = 1,
    height = 1
  ): PdfStructureResult['elements'][number]['regions'][number] => {
    const x = Math.max(0, Math.min(1, box[0] / width))
    const y = Math.max(0, Math.min(1, box[1] / height))
    const right = Math.max(0, Math.min(1, box[2] / width))
    const bottom = Math.max(0, Math.min(1, box[3] / height))
    if (right <= x || bottom <= y) throw new Error('PDF worker returned an empty region.')
    return { page, x, y, width: Math.min(1 - x, right - x), height: Math.min(1 - y, bottom - y) }
  }
  for (const [kind, candidates] of [
    ['figure', raw.figures],
    ['table', raw.tables]
  ] as const) {
    for (const item of candidates) {
      if (!item.region || !item.thumbnail) {
        issues.push({
          code: item.issue ?? 'unresolved-region',
          detail: item.caption?.text ?? item.id
        })
        continue
      }
      const page = raw.pages.find((p) => p.page === item.page)
      if (!page || item.thumbnail !== `thumbnails/${item.id}.png`)
        throw new Error('PDF worker thumbnail identity mismatch.')
      const path = join(root, 'thumbnails', `${item.id}.png`)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 ** 2)
        throw new Error('Invalid PDF worker thumbnail.')
      const bytes = await readFile(path)
      const image = await sharp(bytes, { limitInputPixels: 1200 * 1200 }).metadata()
      if (!image.width || !image.height || image.format !== 'png')
        throw new Error('Invalid PDF worker image.')
      thumbnails.set(item.id, bytes)
      inventory.push({
        id: item.id,
        mimeType: 'image/png',
        width: image.width,
        height: image.height,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
      const element: PdfStructureResult['elements'][number] = {
        id: item.id,
        kind,
        regions: [region(item.page, item.region)],
        thumbnailId: item.id,
        ...(item.caption
          ? {
              caption: {
                text: item.caption.text,
                regions: [region(item.page, item.caption.rect, page.width, page.height)]
              }
            }
          : {}),
        issues: []
      }
      if ('cells' in item) {
        element.issues = item.issues.map((code) => ({ code, detail: code }))
        if (item.captionIssue)
          element.issues.push({ code: item.captionIssue, detail: item.captionIssue })
        if (item.grid.length && item.grid[0].length && item.cells.length) {
          element.table = {
            rowCount: item.grid.length,
            columnCount: item.grid[0].length,
            cells: item.cells.map((cell) => ({
              row: cell.row,
              column: cell.column,
              rowSpan: cell.rowSpan,
              columnSpan: cell.colSpan,
              text: cell.text,
              regions: cell.sourceRects.map((box) =>
                region(item.page, box, item.sourceViewport.width, item.sourceViewport.height)
              )
            })),
            unassignedText: item.unassigned.map((text) => ({ text, regions: [] })),
            ...(item.notes?.length
              ? {
                  notes: item.notes.map((note) => ({
                    text: note.text,
                    regions: [region(item.page, note.rect, page.width, page.height)]
                  }))
                }
              : {}),
            issues: item.issues.map((code) => ({ code, detail: code }))
          }
        }
      }
      elements.push(element)
    }
  }
  return parsePdfStructureResult(
    {
      schemaVersion: 1,
      ...identity,
      pageCount: raw.pageCount,
      requestedPages: raw.requestedPages,
      processedPages: raw.processedPages,
      pages: raw.pages,
      elements,
      thumbnails: inventory,
      navigation: raw.navigation.entries,
      issues
    },
    identity
  )
}
