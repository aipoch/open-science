import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { resolve } from './paths'
const { anonymousCompositingFigure } = await import(
  pathToFileURL(resolve('test/fixtures/native-compositing-scope.mjs')).href
)
const { createNativeCompositingProfile, nativeCompositingProfileData } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-compositing-profile.mjs')).href
)
const { nativeCompositingFigureCrop, nativeCompositingFigurePngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-compositing-scope.mjs')).href
)
const { nativeClosedProgramInkPacket, nativeCompositingInkPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
it('owns the whole labeled figure while retaining the real nonopaque mask and tiling program', () => {
  const f = anonymousCompositingFigure(),
    before = JSON.stringify(f.o)
  const out = nativeCompositingFigureCrop(...f.args)
  expect(out?.sourceItems.map((s: { text: string }) => s.text)).toEqual(['x', 'legend'])
  expect(out?.rect).toEqual([40, 150, 260, 260])
  expect(nativeCompositingFigurePngSafe(f.png, f.rect, f.page, out)).toBe(true)
  expect(JSON.stringify(f.o)).toBe(before)
  expect(
    nativeClosedProgramInkPacket(f.page, f.tokens, f.context, out?.sourceItems)
  ).toBeUndefined()
})
it('retains a complete under-budget RGBA figure in the actual worker heap without indexing every pixel', () => {
  const fixtureUrl = pathToFileURL(resolve('test/fixtures/native-compositing-scope.mjs')).href,
    profileUrl = pathToFileURL(
      resolve('resources/literature-pdf-native-compositing-profile.mjs')
    ).href,
    cropUrl = pathToFileURL(
      resolve('resources/literature-pdf-figure-native-compositing-scope.mjs')
    ).href,
    script = `
      import assert from 'node:assert/strict';
      import {createHash} from 'node:crypto';
      const {anonymousCompositingFigure} = await import(${JSON.stringify(fixtureUrl)});
      const {createNativeCompositingProfile,nativeCompositingProfileData} = await import(${JSON.stringify(profileUrl)});
      const {nativeCompositingFigureCrop,nativeCompositingFigurePngSafe} = await import(${JSON.stringify(cropUrl)});
      const f=anonymousCompositingFigure(),width=1936,height=1936,data=new Uint8Array(width*height*4);
      data.fill(128);
      Object.assign(f.image,{width,height,data});Object.assign(f.images[0],{width,height,data});
      f.o.argsArray[f.imageIndex][1]=width;f.o.argsArray[f.imageIndex][2]=height;
      f.context.graphicsBounds[0].imageHash=createHash('sha256').update(width+':'+height+':3:').update(data).digest('hex');
      const profile=createNativeCompositingProfile(f.page,f.tokens,f.context,f.images),out=nativeCompositingFigureCrop(...f.args);
      assert(profile);assert(out);assert.deepEqual(out.rect,[40,150,260,260]);
      assert.equal(nativeCompositingFigurePngSafe(f.png,f.rect,f.page,out),true);
      await Promise.resolve();data[data.length-1]^=1;
      assert.equal(nativeCompositingProfileData(profile,f.page,f.tokens,f.context),undefined);
      assert.equal(nativeCompositingFigurePngSafe(f.png,f.rect,f.page,out),false);
      console.log(JSON.stringify({decodedBytes:data.length,complete:true}));
    `,
    result = spawnSync(
      process.execPath,
      ['--max-old-space-size=512', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 }
    )
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ decodedBytes: 14_992_384, complete: true })
}, 25_000)
it('declines a compositing body unrelated to the detected figure', () => {
  const f = anonymousCompositingFigure()
  f.figure.rect = [40, 265, 360, 285]
  expect(nativeCompositingFigureCrop(...f.args)).toBeUndefined()
})
it.each([false, true])(
  'keeps a composited companion throughout the body-to-caption lane: %s',
  (outsideSeed) => {
    const f = anonymousCompositingFigure()
    f.figure.rect = outsideSeed ? [40, 150, 220, 265] : [40, 150, 220, 285]
    const show = f.o.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.showText && f.o.argsArray[i][0][0].unicode === 'Figure 1: Composite view.'
      ),
      at = show - 3
    f.o.fnArray.splice(at, 0, OPS.constructPath)
    f.o.argsArray.splice(at, 0, [
      OPS.fill,
      [new Float32Array([0, 60, 120, 1, 100, 120, 1, 100, 130, 1, 60, 130, 4])],
      new Float32Array([60, 120, 100, 130])
    ])
    expect(nativeCompositingFigureCrop(...f.args)).toBeUndefined()
  }
)
it.each(['width', 'height', 'scale', 'rotation', 'transform', 'convertToViewportPoint'])(
  'rejects inherited viewport accessors without reading them: %s',
  (field) => {
    const f = anonymousCompositingFigure(),
      viewport = f.context.viewport,
      value = viewport[field],
      prototype = Object.getPrototypeOf(viewport)
    let reads = 0
    delete viewport[field]
    Object.setPrototypeOf(
      viewport,
      Object.create(prototype, {
        [field]: {
          get() {
            reads++
            return value
          },
          configurable: true
        }
      })
    )
    expect(createNativeCompositingProfile(f.page, f.tokens, f.context, f.images)).toBeUndefined()
    expect(reads).toBe(0)
  }
)
it('declines an unowned native word in the caption lane without a navigation token', () => {
  const f = anonymousCompositingFigure(),
    item = f.context.content.items.find((item: { str: string }) => item.str === 'External prose'),
    show = f.o.fnArray.findIndex(
      (op: number, i: number) =>
        op === OPS.showText && f.o.argsArray[i][0][0].unicode === 'External prose'
    )
  item.transform[5] = 120
  f.o.argsArray[show - 1][0][5] = 120
  f.tokens.splice(
    f.tokens.findIndex(
      (t: { sourceItem: { text: string } }) => t.sourceItem.text === 'External prose'
    ),
    1
  )
  expect(nativeCompositingFigureCrop(...f.args)).toBeUndefined()
})
it.each(['table', 'caption'])(
  'declines unresolved composite caption-lane ownership: %s',
  (mode) => {
    const f = anonymousCompositingFigure()
    if (mode === 'table') f.args[3].push([80, 270, 160, 280])
    if (mode === 'caption')
      f.args[2].push({ page: 1, rect: [80, 270, 160, 282], lines: ['Figure 2: Other.'] })
    expect(nativeCompositingFigureCrop(...f.args)).toBeUndefined()
  }
)
it.each([
  'missing-sha',
  'bad-sha',
  'missing-page',
  'zero-page',
  'fractional-page',
  'different-page',
  'missing-viewport',
  'bad-transform',
  'bad-scale',
  'bad-dimensions'
])('rejects malformed identity at the profile factory: %s', (mode) => {
  const f = anonymousCompositingFigure()
  if (mode === 'missing-sha') {
    delete f.context.sourceSha256
    delete f.images[0].sourceSha256
  }
  if (mode === 'bad-sha') f.context.sourceSha256 = f.images[0].sourceSha256 = 'unverified'
  if (mode === 'missing-page') {
    delete f.page.pageNumber
    delete f.context.pageNumber
  }
  if (mode === 'zero-page') f.page.pageNumber = f.context.pageNumber = 0
  if (mode === 'fractional-page') f.page.pageNumber = f.context.pageNumber = 1.5
  if (mode === 'different-page') f.context.pageNumber = 2
  if (mode === 'missing-viewport') delete f.context.viewport
  if (mode === 'bad-transform') f.context.viewport.transform = [1, 0.1, 0, -1, 0, 400]
  if (mode === 'bad-scale') f.context.viewport.scale = 0
  if (mode === 'bad-dimensions') f.context.viewport.width--
  expect(createNativeCompositingProfile(f.page, f.tokens, f.context, f.images)).toBeUndefined()
})
it.each([
  'mask',
  'group',
  'activation',
  'end',
  'pattern-text',
  'pattern-font',
  'unproved-dependency',
  'pattern-step',
  'image',
  'foreign-font',
  'foreign-zero',
  'owned-zero',
  'white-label'
])('refuses an unclosed resource or source domain: %s', (mode) => {
  const f = anonymousCompositingFigure()
  if (mode === 'mask')
    f.o.argsArray[f.o.fnArray.indexOf(OPS.beginGroup) + 2][0].smask.subtype = 'Luminosity'
  if (mode === 'group') f.o.argsArray[f.o.fnArray.indexOf(OPS.beginGroup)][0].isolated = false
  if (mode === 'activation') f.o.argsArray[f.activationIndex][0][0][1] = false
  if (mode === 'end') {
    f.o.argsArray[f.endIndex] = structuredClone(f.o.argsArray[f.endIndex])
    f.o.argsArray[f.endIndex][0].bbox[2]--
  }
  if (mode === 'pattern-text')
    f.o.argsArray[f.patternIndex][2].argsArray[5][1] = [
      { fnArray: [OPS.showText], argsArray: [[[]]], length: 1 }
    ]
  if (mode === 'pattern-font') f.o.argsArray[f.patternIndex][2].fnArray[3] = OPS.setFont
  if (mode === 'unproved-dependency') {
    f.o.fnArray.splice(f.imageIndex, 0, OPS.dependency)
    f.o.argsArray.splice(f.imageIndex, 0, ['unknown-font-resource'])
    f.images[0].operationIndex++
    f.context.graphicsBounds[0].operationIndex++
  }
  if (mode === 'pattern-step') f.o.argsArray[f.patternIndex][5] = 0
  if (mode === 'image') f.image.data[3] ^= 1
  if (mode === 'foreign-font') f.context.content.items.at(-1).fontName = 'unknown'
  if (mode === 'foreign-zero') f.context.content.items.at(-1).width = 1
  if (mode === 'owned-zero') {
    f.context.content.items[0].width = 0
    f.tokens[0].rect[2] = f.tokens[0].rect[0]
    const i = f.o.fnArray.indexOf(OPS.showText)
    f.o.argsArray[i][0][0].width = 0
  }
  if (mode === 'white-label') {
    const i = f.o.fnArray.indexOf(OPS.save, f.endIndex)
    f.o.fnArray.splice(i + 1, 0, OPS.setFillRGBColor)
    f.o.argsArray.splice(i + 1, 0, ['#ffffff'])
  }
  expect(nativeCompositingFigureCrop(...f.args)).toBeUndefined()
})
it('does not execute resource accessors', () => {
  const f = anonymousCompositingFigure()
  let reads = 0
  Object.defineProperty(f.images[0], 'data', {
    get() {
      reads++
      throw new Error('not a native data field')
    }
  })
  expect(createNativeCompositingProfile(f.page, f.tokens, f.context, f.images)).toBeUndefined()
  expect(reads).toBe(0)
})
it.each(['buffer', 'byteOffset', 'byteLength', 'length', 'toJSON', Symbol.iterator])(
  'rejects shadowed native byte-window fields without evaluating them: %s',
  (key) => {
    const f = anonymousCompositingFigure()
    let reads = 0
    Object.defineProperty(f.image.data, key, {
      get() {
        reads++
        throw new Error('shadowed native byte view')
      }
    })
    expect(createNativeCompositingProfile(f.page, f.tokens, f.context, f.images)).toBeUndefined()
    expect(nativeCompositingFigureCrop(...f.args)).toBeUndefined()
    expect(reads).toBe(0)
  }
)
it('never interprets unused typed-view expandos and still binds the complete consumed byte window', async () => {
  const f = anonymousCompositingFigure()
  let reads = 0
  Object.defineProperty(f.image.data, 'unused', {
    configurable: true,
    get() {
      reads++
      throw new Error('unconsumed expando')
    }
  })
  const profile = createNativeCompositingProfile(f.page, f.tokens, f.context, f.images)
  expect(profile).toBeTruthy()
  expect(nativeCompositingFigureCrop(...f.args)).toBeTruthy()
  await Promise.resolve()
  Object.defineProperty(f.image.data, 'unused', { value: 'still unconsumed' })
  expect(nativeCompositingProfileData(profile, f.page, f.tokens, f.context)).toBeTruthy()
  f.image.data[f.image.data.length - 1] ^= 1
  expect(nativeCompositingProfileData(profile, f.page, f.tokens, f.context)).toBeUndefined()
  expect(reads).toBe(0)
})
it('invalidates a viewport method replaced on its retained prototype across an await', async () => {
  const f = anonymousCompositingFigure(),
    viewport = f.context.viewport,
    method = viewport.convertToViewportPoint
  delete viewport.convertToViewportPoint
  const prototype = Object.create(Object.getPrototypeOf(viewport), {
    convertToViewportPoint: { value: method, writable: true, configurable: true }
  })
  Object.setPrototypeOf(viewport, prototype)
  const profile = createNativeCompositingProfile(f.page, f.tokens, f.context, f.images)
  expect(profile).toBeTruthy()
  await Promise.resolve()
  Object.defineProperty(prototype, 'convertToViewportPoint', { value: method.bind(viewport) })
  expect(nativeCompositingProfileData(profile, f.page, f.tokens, f.context)).toBeUndefined()
})
it('invalidates a profile whose derived scope reference is replaced', async () => {
  const f = anonymousCompositingFigure(),
    profile = createNativeCompositingProfile(f.page, f.tokens, f.context, f.images)
  const scope = nativeCompositingProfileData(profile, f.page, f.tokens, f.context)
  expect(scope).toBeTruthy()
  await Promise.resolve()
  scope.rect = [...scope.rect]
  expect(nativeCompositingProfileData(profile, f.page, f.tokens, f.context)).toBeUndefined()
  expect(nativeCompositingInkPacket(f.page, f.tokens, f.context, profile)).toBeUndefined()
})
it.each(['bytes', 'buffer', 'pattern-reference', 'output-reference', 'png'])(
  'invalidates the whole certificate across an await: %s',
  async (mode) => {
    const f = anonymousCompositingFigure(),
      out = nativeCompositingFigureCrop(...f.args)
    expect(out).toBeTruthy()
    await Promise.resolve()
    if (mode === 'bytes') f.image.data[3] ^= 1
    if (mode === 'buffer') f.images[0].data = new Uint8Array(f.images[0].data)
    if (mode === 'pattern-reference')
      f.o.argsArray[f.patternIndex][3] = [...f.o.argsArray[f.patternIndex][3]]
    if (mode === 'output-reference') out.sourceItems = [...out.sourceItems]
    expect(
      nativeCompositingFigurePngSafe(mode === 'png' ? new Uint8Array() : f.png, f.rect, f.page, out)
    ).toBe(false)
  }
)
