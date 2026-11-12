import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousBoundedPixelProgram } = await import(
  pathToFileURL(resolve('test/fixtures/native-bounded-pixel-program.mjs')).href
)
const { createNativeBoundedPixelProgram: create, nativeBoundedPixelProgramData: data } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-native-bounded-pixel-program.mjs')).href
  )
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')

it.each([1, 2])(
  'binds a real %i-level isolated curved-clip program without exact-clip authority',
  async (depth) => {
    const f = await anonymousBoundedPixelProgram({ depth })
    try {
      const handle = create(f.page, f.tokens, f.context),
        p = data(handle, f.page, f.tokens, f.context)
      expect(p).toBeDefined()
      expect(p.stats.maxGroupDepth).toBe(depth)
      expect(
        p.packedPaths.bounds.byteLength +
          p.packedPaths.operationIndices.byteLength +
          p.packedPaths.floors.byteLength +
          p.packedPaths.clipIndices.byteLength +
          p.packedPaths.scopeIndices.byteLength +
          p.packedPaths.paintFlags.byteLength +
          p.packedPaths.partitions.byteLength
      ).toBe(p.stats.pathCount * 54)
      const curved = p.clips.find((c) => c.kind === 'path' && !c.exactClip)
      expect(curved.tag).toBe('Bounded')
      expect(curved.originalPaths[0].length).toBe(47)
      expect(curved.exactClip).toBeNull()
      expect(curved.bounds).toEqual([50, 100, 150, 200])
      expect(p.stats.sourceAuthority).toBe(false)
      expect(p.stats.visibilityAuthority).toBe(false)
      const ink = [...p.evidence.paths.values()].find((r) => r.paints)
      expect(ink.clip).toBeNull()
      expect(ink.originalArgs).toBe(p.o.argsArray[ink.operationIndex])
      expect(ink.originalPath).toBe(ink.originalArgs[1][0])
      expect(ink.visiblePaintPoints).toBeUndefined()
      // The real PDF renderer still cuts the rounded corner, rather than
      // replacing its clip with the conservative rectangular envelope.
      expect([...f.canvas.getContext('2d').getImageData(76, 151, 1, 1).data]).toEqual([
        255, 255, 255, 255
      ])
      expect([...f.canvas.getContext('2d').getImageData(150, 255, 1, 1).data]).toEqual([
        0, 0, 255, 255
      ])
      expect(data(handle, f.page, f.tokens, f.context)).toBe(p)
    } finally {
      await f.cleanup()
    }
  }
)

it('keeps genuinely rectangular clips exact', async () => {
  const f = await anonymousBoundedPixelProgram({ mode: 'rectangle' })
  try {
    const p = data(create(f.page, f.tokens, f.context), f.page, f.tokens, f.context)
    expect(p).toBeDefined()
    expect(p.clips.find((c) => c.kind === 'path').exactClip).toEqual([50, 100, 150, 200])
  } finally {
    await f.cleanup()
  }
})

it.each(['touching-clip', 'tiny-gap-clip', 'far-disjoint-clip', 'empty'])(
  'declines %s intersections instead of inferring empty raster paint',
  async (mode) => {
    const f = await anonymousBoundedPixelProgram({ mode })
    try {
      const raster = f.canvas.getContext('2d').getImageData(220, 190, 12, 70).data
      let blue = 0
      for (let n = 0; n < raster.length; n += 4) if (raster[n + 2] > raster[n]) blue++
      if (mode === 'touching-clip') expect(blue).toBeGreaterThan(0)
      else expect(blue).toBe(0)
      // Clip masks can overlap at device-pixel edges even when their
      // mathematical AABBs touch or have a small gap. A geometric intersection
      // is never an independent zero-paint witness for the original renderer.
      expect(create(f.page, f.tokens, f.context)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it.each(['unclosed', 'multicontour', 'nonisolated'])(
  'rejects unsupported actual native %s clips/groups',
  async (mode) => {
    const f = await anonymousBoundedPixelProgram({ mode })
    try {
      expect(create(f.page, f.tokens, f.context)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it('refuses a third native isolated layer', async () => {
  const f = await anonymousBoundedPixelProgram({ depth: 3 })
  try {
    expect(create(f.page, f.tokens, f.context)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['raw-path', 'packed-bound', 'packet-identity'])(
  'invalidates the whole witness after %s mutation',
  async (kind) => {
    const f = await anonymousBoundedPixelProgram()
    try {
      const h = create(f.page, f.tokens, f.context),
        p = data(h, f.page, f.tokens, f.context)
      expect(p).toBeDefined()
      if (kind === 'raw-path') p.evidence.paths.at(0).originalPath[1] += 1
      else if (kind === 'packed-bound') p.packedPaths.bounds[0] += 1
      else f.context.operators.argsArray = [...f.context.operators.argsArray]
      expect(data(h, f.page, f.tokens, f.context)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it.each([OPS.beginMarkedContentProps, OPS.shadingFill, OPS.setStrokeColorN])(
  'declines unknown visibility or paint operation %i rather than omitting it',
  async (op) => {
    const f = await anonymousBoundedPixelProgram()
    try {
      f.context.operators.fnArray.push(op)
      f.context.operators.argsArray.push(
        op === OPS.beginMarkedContentProps ? ['OC', 'unbound'] : []
      )
      expect(create(f.page, f.tokens, f.context)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it('does not grant an unbound copy the identity of an accepted program', async () => {
  const f = await anonymousBoundedPixelProgram()
  try {
    const h = create(f.page, f.tokens, f.context)
    expect(data(h, { ...f.page }, f.tokens, f.context)).toBeUndefined()
    expect(data(h, f.page, [...f.tokens], f.context)).toBeUndefined()
    expect(data(h, f.page, f.tokens, { ...f.context })).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('inventories an overlapping foreign glyph packet without assigning it to the drawing scope', async () => {
  const f = await anonymousBoundedPixelProgram({ mode: 'foreign' })
  try {
    const p = data(create(f.page, f.tokens, f.context), f.page, f.tokens, f.context)
    expect(p).toBeDefined()
    expect([...p.evidence.texts.values()].filter((t) => t.scope === 0xffffffff)).toHaveLength(2)
    expect([...p.evidence.texts.values()].some((t) => t.scope !== 0xffffffff)).toBe(true)
    expect(p.scopes.every((s) => s.end > s.begin)).toBe(true)
  } finally {
    await f.cleanup()
  }
})

it.each(['shadow', 'symbol', 'prototype', 'detached'])(
  'invalidates %s changes on newly packed numeric storage',
  async (kind) => {
    const f = await anonymousBoundedPixelProgram()
    try {
      const h = create(f.page, f.tokens, f.context),
        p = data(h, f.page, f.tokens, f.context)
      expect(p).toBeDefined()
      if (kind === 'shadow')
        Object.defineProperty(p.packedPaths.bounds, 'buffer', {
          get: () => {
            throw Error('must not execute')
          }
        })
      else if (kind === 'symbol') p.packedPaths.bounds[Symbol('foreign')] = 1
      else if (kind === 'prototype')
        Object.setPrototypeOf(p.packedPaths.bounds, Float32Array.prototype)
      else structuredClone(p.packedPaths.bounds.buffer, { transfer: [p.packedPaths.bounds.buffer] })
      expect(p.current()).toBe(false)
      expect(data(h, f.page, f.tokens, f.context)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it('does not execute input metadata accessors', async () => {
  const f = await anonymousBoundedPixelProgram()
  let invoked = false
  try {
    Object.defineProperty(f.context, 'operators', {
      get: () => {
        invoked = true
        throw Error('foreign accessor')
      }
    })
    expect(create(f.page, f.tokens, f.context)).toBeUndefined()
    expect(invoked).toBe(false)
  } finally {
    await f.cleanup()
  }
})

it.each(['path-count', 'path-scalars', 'total-scalars'])(
  'rejects finite %s overflow before accepting an incomplete inventory',
  async (kind) => {
    const f = await anonymousBoundedPixelProgram()
    try {
      const o = f.context.operators
      if (kind === 'path-count') {
        const i = o.fnArray.findIndex(
          (op, i) => op === OPS.constructPath && o.argsArray[i][0] === OPS.fill
        )
        const needed = 16385 - o.fnArray.filter((op) => op === OPS.constructPath).length
        o.fnArray.push(...Array(needed).fill(OPS.constructPath))
        o.argsArray.push(...Array(needed).fill(o.argsArray[i]))
      } else {
        const segments = kind === 'path-scalars' ? 5461 : 5460,
          p = new Float64Array((segments + 1) * 3)
        p.set([0, 10, 10])
        for (let n = 0; n < segments; n++) p.set([1, n % 2 ? 20 : 10, n % 2 ? 20 : 10], (n + 1) * 3)
        const copies = kind === 'total-scalars' ? 129 : 1
        for (let n = 0; n < copies; n++) {
          o.fnArray.push(OPS.constructPath)
          o.argsArray.push([OPS.fill, [p], new Float32Array([10, 10, 20, 20])])
        }
      }
      expect(create(f.page, f.tokens, f.context)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)
