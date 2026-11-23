import { createCanvas } from '@napi-rs/canvas'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PDFDocument, rgb } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'
import { expect, it, onTestFinished } from 'vitest'

const require = createRequire(import.meta.url)
const fontkit = require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0]

it.each(['ordered', 'reordered', 'missing circle'])(
  'keeps the relationship between the native swatch colors and their entries (%s)',
  async (mode) => {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(
        await readFile(
          join(
            dirname(require.resolve('pdfjs-dist/package.json')),
            'standard_fonts',
            'LiberationSans-Regular.ttf'
          )
        ),
        { subset: false }
      ),
      page = pdf.addPage([600, 800]),
      sourceRuns = ['– CAT, ', '●', ' – DOG, ', '●', ' – RAT, ', '●', ' – other samples).'],
      source = sourceRuns.join(''),
      unmodified = '– CAT，● – DOG，● – RAT，● – 其他样本）。',
      translation =
        mode === 'reordered'
          ? '– CAT，● – RAT，● – DOG，● – 其他样本）。'
          : mode === 'missing circle'
            ? unmodified.replace('● – RAT', '– RAT')
            : unmodified,
      colors = [rgb(1, 0, 0), rgb(0, 0.5, 0.5), rgb(0, 0, 1)],
      size = 8.5,
      left = 100,
      y = 650
    let right = left
    for (const [index, text] of sourceRuns.entries()) {
      page.drawText(text, {
        x: right,
        y,
        size,
        font,
        color: index % 2 ? colors[(index - 1) / 2] : rgb(0, 0, 0)
      })
      right += font.widthOfTextAtSize(text, size)
    }
    const registry = new TestCallerRegistry()
    onTestFinished(() => registry.dispose())
    const { lease } = registry.acquire({ leaseId: 'colored-legend-roundtrip' })
    const data = await pdf.save(),
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs')),
      output = await writer.generateDetailed(
        {
          id: 'colored-inline-legend',
          data,
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: true,
          preserveUnmatched: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: left / 600,
                    y: (800 - y - 8) / 800,
                    width: (right - left + 15) / 600,
                    height: 11 / 800
                  }
                }
              ]
            }
          ]
        },
        lease
      )
    if (mode !== 'ordered') {
      expect(output!.layoutFailures).toMatchObject([{ unitIndex: 0, code: 'unsupported-layout' }])
      expect(output!.data).toEqual(data)
      return
    }
    expect(output!.layoutFailures).toEqual([])
    const loading = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => loading.destroy())
    const target = await (await loading.promise).getPage(1)
    const text = (await target.getTextContent()).items
      .map((item) => ('str' in item ? item.str : ''))
      .join('')
    expect(text.replace(/\s/gu, '')).toBe(translation.replace(/\s/gu, ''))
    const viewport = target.getViewport({ scale: 2 })
    const canvas = createCanvas(viewport.width, viewport.height)
    const context = canvas.getContext('2d')
    await target.render({ canvas: null, canvasContext: context as never, viewport }).promise
    const box = context.getImageData(left * 2, (800 - y - 8) * 2, (right - left + 15) * 2, 22)
    const pixels = [undefined, undefined, undefined] as Array<number | undefined>
    for (let channel = 0; channel < box.data.length; channel += 4) {
      const [r, g, b] = box.data.subarray(channel, channel + 3)
      const order =
        r === 255 && g === 0 && b === 0
          ? 0
          : r === 0 && g >= 125 && g <= 130 && g === b
            ? 1
            : r === 0 && g === 0 && b === 255
              ? 2
              : -1
      if (order >= 0) pixels[order] ??= (channel / 4) % box.width
    }
    expect(pixels).toEqual(pixels.toSorted((a, b) => Number(a) - Number(b)))
    expect(pixels.every((x) => x !== undefined)).toBe(true)
  }
)
