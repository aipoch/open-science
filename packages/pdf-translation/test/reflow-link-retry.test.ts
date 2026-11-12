import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { expect, it, vi } from 'vitest'
import { generateReflow } from '../resources/reflow.mjs'

const control = vi.hoisted(() => ({
  failures: [] as number[][],
  attempts: [] as number[][]
}))

// Only failure reports are injected. The final pass uses the real mapper and
// real source PDF, so an incomplete navigation map cannot become an output.
vi.mock('../resources/reflow-links.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resources/reflow-links.mjs')>()
  return {
    ...actual,
    mapReflowLinks: (
      ...args: Parameters<typeof actual.mapReflowLinks>
    ): ReturnType<typeof actual.mapReflowLinks> => {
      control.attempts.push([...args[2].originals.keys()].sort((a, b) => a - b))
      const result = actual.mapReflowLinks(...args)
      return control.failures.length
        ? { ...result, failed: new Set(control.failures.shift()) }
        : result
    }
  }
})

async function source(): Promise<Parameters<typeof generateReflow>[0]> {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    words = ['Alpha.', 'Beta.', 'Gamma.']
  for (const word of words)
    pdf.addPage([400, 500]).drawText(word, { font, x: 40, y: 440, size: 12 })
  for (const index of [0, 1])
    pdf.getPage(index).node.addAnnot(
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [40, 438, 80, 453],
          Border: [0, 0, 0],
          Dest: [pdf.getPage(index + 1).ref, PDFName.of('XYZ'), 40, 450, null]
        })
      )
    )
  return {
    data: await pdf.save(),
    pages: words.map(() => ({ width: 400, height: 500 })),
    units: words.map((word, index) => ({
      source: word,
      translation: word + ' Translated.',
      kind: 'text',
      fragments: [{ pageNumber: index + 1, rect: { x: 0.1, y: 0.08, width: 0.8, height: 0.05 } }]
    }))
  }
}

it('tries local endpoints once before retaining the connected navigation component', async () => {
  control.failures = [[1], [3]]
  control.attempts = []
  const output = await generateReflow(await source())
  expect(control.attempts).toEqual([[], [1], [1, 2, 3]])
  expect(output.reflow.originalPageNumbers).toEqual([1, 2, 3])
  expect(output.layoutFailures.map((f) => f.code)).toEqual([
    'annotations',
    'annotations',
    'annotations'
  ])
  expect(control.failures).toEqual([])
})

it('stops when a copied endpoint still fails instead of retrying without progress', async () => {
  control.failures = [[1], [1]]
  control.attempts = []
  await expect(generateReflow(await source())).rejects.toThrow('Reflow link fallback failed')
  expect(control.attempts).toEqual([[], [1]])
  expect(control.failures).toEqual([])
})
