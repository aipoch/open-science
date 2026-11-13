/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { PDFDocument, PDFName } from 'pdf-lib'
import { anonymousNonisolatedColumnExclusion } from './nonisolated-column-exclusion.mjs'
import { captureAnonymousVerticalFigureBytes } from './vertical-native-subcaptions.mjs'

// Author a combining slash using the redistributable bundled slash outline.
// Its declared PDF CID width and Unicode map are established before parsing;
// no captured Source, glyph, or native render carrier is modified.
export async function anonymousExteriorZeroOutline(fault = '') {
  const original = await anonymousNonisolatedColumnExclusion()
  let bytes
  try {
    const require = createRequire(import.meta.url)
    const assets = dirname(require.resolve('pdfjs-dist/package.json'))
    const document = await PDFDocument.load(original.bytes)
    const fontkit = require('fontkit')
    // pdf-lib consumes the older stream interface; fontkit 2 returns bytes.
    document.registerFontkit({
      create(data) {
        const face = fontkit.create(data)
        const createSubset = face.createSubset.bind(face)
        face.createSubset = () => {
          const subset = createSubset()
          subset.encodeStream = () => Readable.from([subset.encode()])
          return subset
        }
        return face
      }
    })
    const font = await document.embedFont(
      await readFile(join(assets, 'standard_fonts/LiberationSans-Regular.ttf')),
      { subset: true }
    )
    const page = document.getPage(0)
    const fontName = page.node.newFontDictionary('Overlay', font.ref)
    const anchor = 'BT /R 11 Tf 1 0 0 1 50 392 Tm'
    const contents = page.node.normalizedEntries().Contents
    const sources = Array.from({ length: contents.size() }, (_, index) =>
      Buffer.from(contents.lookup(index).getContents()).toString('utf8')
    ).filter((source) => source.includes(anchor))
    assert.equal(sources.length, 1)
    const [source] = sources
    assert.equal(source.split(anchor).length, 2)
    const x = fault === 'crossing-outline' ? 335 : 80
    const encoded = font.encodeText('/')
    const overlay = `BT ${fontName} 11 Tf 1 0 0 1 ${x} 400 Tm ${encoded} Tj ET `
    const replacement = document.context.flateStream(source.replace(anchor, overlay + anchor))
    page.node.set(PDFName.of('Contents'), document.context.register(replacement))
    await document.flush()
    const type0 = document.context.lookup(font.ref)
    const cid = type0.lookup(PDFName.of('DescendantFonts')).lookup(0)
    const code = encoded.toString().slice(1, -1)
    cid.set(PDFName.of('W'), document.context.obj([parseInt(code, 16), [0]]))
    const unicode = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /AnonymousOverlay def /CMapType 2 def',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      `1 beginbfchar <${code}> <0338> endbfchar`,
      'endcmap CMapName currentdict /CMap defineresource pop end end'
    ].join('\n')
    type0.set(
      PDFName.of('ToUnicode'),
      document.context.register(document.context.flateStream(unicode))
    )
    bytes = Buffer.from(await document.save({ useObjectStreams: false }))
  } finally {
    await original.cleanup()
  }
  return captureAnonymousVerticalFigureBytes(bytes)
}
