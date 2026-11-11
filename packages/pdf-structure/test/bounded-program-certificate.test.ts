import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousBoundedPixelProgram } = await import(
  pathToFileURL(resolve('test/fixtures/native-bounded-pixel-program.mjs')).href
)
const {
  createNativeBoundedFigurePixelCertificate: create,
  nativeBoundedFigurePixelCertificateData: data,
  createNativeArrayBoundFigurePixelCertificate,
  nativeWholeCellInkPacket
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)

it('binds complete native literals while bounded clips grant no default Source authority', async () => {
  const f = await anonymousBoundedPixelProgram({ depth: 2, mode: 'figure' })
  try {
    const handle = create(f.page, f.tokens, f.context)
    const packet = data(handle, f.page, f.tokens, f.context)
    expect(packet).toBeDefined()
    expect(packet.records.length).toBe(f.tokens.length)
    expect(packet.program.packedPaths.count).toBeGreaterThan(0)
    expect(packet.program.clips.some((c) => c.kind === 'path' && c.exactClip === null)).toBe(true)
    expect(
      createNativeArrayBoundFigurePixelCertificate(f.page, f.tokens, f.context)
    ).toBeUndefined()
    expect(
      nativeWholeCellInkPacket(f.page, f.tokens, f.context, {
        text: f.tokens.map((t) => t.text).join(''),
        sourceItems: f.tokens.map((t) => t.sourceItem),
        sourceRects: f.tokens.map((t) => t.rect)
      })
    ).toBeUndefined()
    expect(data(handle, { ...f.page }, f.tokens, f.context)).toBeUndefined()
    expect(data(handle, f.page, [...f.tokens], f.context)).toBeUndefined()
    expect(data({}, f.page, f.tokens, f.context)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('withdraws a pixel certificate when its retained glyph evidence changes', async () => {
  const f = await anonymousBoundedPixelProgram({ mode: 'figure' })
  try {
    const handle = create(f.page, f.tokens, f.context)
    const packet = data(handle, f.page, f.tokens, f.context)
    expect(packet).toBeDefined()
    packet.glyphs[0].ink[0] += 1
    expect(data(handle, f.page, f.tokens, f.context)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('rejects a forged native literal or duplicate token before publishing pixel evidence', async () => {
  const f = await anonymousBoundedPixelProgram({ mode: 'figure' })
  try {
    f.tokens.push({ ...f.tokens[0] })
    expect(create(f.page, f.tokens, f.context)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})
