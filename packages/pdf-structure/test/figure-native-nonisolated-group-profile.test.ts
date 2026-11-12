import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const profileModule = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-figure-recovery-profile.mjs')).href
)

const fixture = (): ReturnType<typeof JSON.parse> => {
  const page = {
    pageNumber: 4,
    width: 400,
    height: 400,
    rotation: 0,
    invalidGraphicsBounds: 0
  }
  const tokens: unknown[] = []
  const group = {
    matrix: null,
    bbox: [10, 10, 390, 300],
    smask: null,
    isolated: false,
    knockout: false
  }
  const operators = {
    fnArray: [
      OPS.transform,
      OPS.save,
      OPS.beginGroup,
      OPS.paintFormXObjectBegin,
      OPS.setFillRGBColor,
      OPS.constructPath,
      OPS.fill,
      OPS.paintFormXObjectEnd,
      OPS.endGroup,
      OPS.restore
    ],
    argsArray: [
      [1, 0, 0, 1, 0, 0],
      null,
      [group],
      [null, null],
      [0, 0, 0],
      [OPS.fill, [[OPS.rectangle, 20, 20, 40, 30]], [20, 20, 60, 50]],
      null,
      null,
      [group],
      null
    ]
  }
  const context = {
    operators,
    viewport: {
      width: 400,
      height: 400,
      rotation: 0,
      scale: 1,
      transform: [1, 0, 0, -1, 0, 400],
      convertToViewportPoint: (x: number, y: number) => [x, 400 - y]
    },
    content: { items: [], styles: {} },
    glyphBounds: [],
    graphicsBounds: [
      { kind: 'path', operationIndex: 6, normalizedRect: [0.05, 0.05, 0.15, 0.125] }
    ],
    sourceSha256: 'a'.repeat(64),
    pageNumber: 4
  }
  return { page, tokens, context, group }
}

it('observes a bounded nonisolated group for opt-in crop proof only', () => {
  const f = fixture()
  const profile = profileModule.createNativeNonisolatedGroupCropProfile(
      f.page,
      f.tokens,
      f.context
    ),
    groups = profileModule.nativeNonisolatedGroupProfileData(profile, f.page, f.tokens, f.context)

  expect(groups).toEqual([
    {
      begin: 2,
      end: 8,
      depth: 0,
      bbox: [10, 10, 390, 300],
      isolated: false,
      knockout: false,
      matrix: null,
      smask: null,
      backdrop: { priorPaint: false, glyphsRequireIndependentDisjointProof: true }
    }
  ])
  expect(
    profileModule.createNativeFigureRecoveryProfile(f.page, f.tokens, f.context)
  ).toBeUndefined()
})

it('does not attest a nonisolated group when unsupported composition or prior paint is present', () => {
  const f = fixture()
  f.context.operators.fnArray.splice(0, 0, OPS.constructPath)
  f.context.operators.argsArray.splice(0, 0, [
    OPS.fill,
    [[OPS.rectangle, 0, 0, 400, 400]],
    [0, 0, 400, 400]
  ])
  f.context.graphicsBounds.unshift({
    kind: 'path',
    operationIndex: 0,
    normalizedRect: [0, 0, 1, 1]
  })
  const profile = profileModule.createNativeNonisolatedGroupCropProfile(f.page, f.tokens, f.context)

  expect(
    profileModule.nativeNonisolatedGroupProfileData(profile, f.page, f.tokens, f.context)
  ).toBeUndefined()
})

it('rejects forged and stale nonisolated crop profiles', () => {
  const f = fixture(),
    profile = profileModule.createNativeNonisolatedGroupCropProfile(f.page, f.tokens, f.context)
  expect(
    profileModule.nativeNonisolatedGroupProfileData({}, f.page, f.tokens, f.context)
  ).toBeUndefined()
  f.context.sourceSha256 = 'b'.repeat(64)
  expect(
    profileModule.nativeNonisolatedGroupProfileData(profile, f.page, f.tokens, f.context)
  ).toBeUndefined()
})
