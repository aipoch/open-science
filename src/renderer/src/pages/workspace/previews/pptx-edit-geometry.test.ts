import { describe, expect, it } from 'vitest'

import {
  frameToScreen,
  MIN_FRAME_EMU,
  moveFrame,
  pixelsPerEmu,
  resizeFrame,
  sameFrame
} from './pptx-edit-geometry'

const size = { cx: 9_144_000, cy: 5_143_500 }
const box = { x: 20, y: 10, width: 914.4, height: 514.35 }
const frame = { x: 914_400, y: 457_200, w: 1_828_800, h: 914_400, rotationDeg: 15 }

describe('pptx edit geometry', () => {
  it('derives pixels per EMU from the rendered slide width', () => {
    expect(pixelsPerEmu(size, box)).toBeCloseTo(0.0001)
  })

  it('maps a model frame into the reported slide box', () => {
    expect(frameToScreen(frame, size, box)).toEqual({
      left: expect.closeTo(111.44, 1),
      top: expect.closeTo(55.72, 1),
      width: expect.closeTo(182.88, 1),
      height: expect.closeTo(91.44, 1)
    })
  })

  it('converts pixel drags back to whole EMU and keeps rotation', () => {
    const scale = pixelsPerEmu(size, box)
    const moved = moveFrame(frame, 10, -5, scale)
    expect(moved).toMatchObject({ x: 1_014_400, y: 407_200, w: frame.w, rotationDeg: 15 })
    expect(Number.isInteger(moved.x)).toBe(true)
  })

  it('never resizes below the minimum frame', () => {
    const resized = resizeFrame(frame, -100_000, -100_000, pixelsPerEmu(size, box))
    expect(resized.w).toBe(MIN_FRAME_EMU)
    expect(resized.h).toBe(MIN_FRAME_EMU)
  })

  it('detects an unchanged frame and ignores a zero scale', () => {
    expect(sameFrame(frame, moveFrame(frame, 0, 0, 0.0001))).toBe(true)
    expect(sameFrame(frame, moveFrame(frame, 5, 5, 0))).toBe(true)
  })
})
