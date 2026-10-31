import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { afterEach, expect, it } from 'vitest'
import { locatePdfAnnotationGeometry } from './agent-geometry-core'
import { createPdfAnnotationRequestSchema } from '../../shared/pdf-annotations'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(rotation = 0): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'annotation-geometry-'))
  roots.push(root)
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([400, 500])
  page.setCropBox(10, 20, 350, 450)
  page.setRotation(degrees(rotation))
  page.drawText('Before iii WWW after.', { x: 30, y: 420, size: 14, font })
  page.drawText('First repeated text.', { x: 30, y: 360, size: 14, font })
  page.drawText('Second repeated text.', { x: 30, y: 300, size: 14, font })
  const filePath = join(root, 'paper.pdf')
  await writeFile(filePath, await document.save())
  return filePath
}
it.each([0, 90, 180, 270])(
  'locates actual substring geometry at rotation %i with a crop box',
  async (rotation) => {
    const filePath = await fixture(rotation)
    const result = await locatePdfAnnotationGeometry({ filePath, pageNumber: 1, quote: 'iii WWW' })
    expect(result.truncated).toBe(false)
    expect(result.selectors).toHaveLength(1)
    const selector = result.selectors[0]!
    expect(selector).toMatchObject({
      kind: 'text',
      exact: 'iii WWW',
      pageRotation: rotation,
      coordinateVersion: 1
    })
    if (selector.kind !== 'text') throw Error('text selector required')
    expect(selector.quads).toHaveLength(1)
    const rect = selector.quads[0]!
    // The seven characters contain very different advances. A proportional run-width
    // approximation would include adjacent text or miss the final W.
    const uprightWidth = rotation % 180 ? rect.height : rect.width
    const uprightHeight = rotation % 180 ? rect.width : rect.height
    expect(uprightWidth * 350).toBeGreaterThan(50)
    expect(uprightWidth * 350).toBeLessThan(53)
    expect(uprightHeight * 450).toBeGreaterThan(9)
    expect(uprightHeight * 450).toBeLessThan(12)
    if (rotation === 0) {
      expect(rect.y).toBeGreaterThan(0.08)
      expect(rect.y).toBeLessThan(0.1)
    }
    if (rotation === 90) expect(rect.x).toBeGreaterThan(0.88)
    if (rotation === 180) expect(rect.y).toBeGreaterThan(0.88)
    if (rotation === 270) expect(rect.x).toBeLessThan(0.1)
    expect(
      createPdfAnnotationRequestSchema.safeParse({
        id: 'mark',
        literatureVersionId: 'version',
        kind: 'highlight',
        note: '',
        tagIds: [],
        target: {
          source: {
            kind: 'literature-attachment-version',
            sourceFileId: 'file',
            versionId: 'version',
            checksum: 'a'.repeat(64),
            name: 'paper.pdf',
            path: 'literature-attachment-version:version'
          },
          selector
        }
      }).success
    ).toBe(true)
  }
)
it('returns distinct repeated-text candidates, disambiguates by context and refuses missing text/pages', async () => {
  const filePath = await fixture()
  const repeated = await locatePdfAnnotationGeometry({
    filePath,
    pageNumber: 1,
    quote: 'repeated text.'
  })
  expect(repeated.selectors).toHaveLength(2)
  const second = await locatePdfAnnotationGeometry({
    filePath,
    pageNumber: 1,
    quote: 'repeated text.',
    prefix: 'Second'
  })
  expect(second.selectors).toEqual([repeated.selectors[1]])
  expect(
    (await locatePdfAnnotationGeometry({ filePath, pageNumber: 1, quote: 'not on this page' }))
      .selectors
  ).toEqual([])
  await expect(
    locatePdfAnnotationGeometry({ filePath, pageNumber: 2, quote: 'iii WWW' })
  ).rejects.toThrow('TARGET_UNAVAILABLE')
  expect(
    (await locatePdfAnnotationGeometry({ filePath, pageNumber: 1 })).selectors[0]
  ).toMatchObject({ kind: 'page-note', pageNumber: 1 })
})
