import { expect, it } from 'vitest'
import {
  researchVideoExportEstimate,
  researchVideoExportTimeout,
  researchVideoResolutionSchema
} from './export-options.js'

it('scales planning ranges to film duration and keeps an explicit fallback for older players', () => {
  expect(researchVideoExportEstimate('720p', 81.2)).toEqual({ min: 3, max: 9, perMinute: false })
  expect(researchVideoExportEstimate('1080p', 81.2)).toEqual({ min: 5, max: 14, perMinute: false })
  expect(researchVideoExportEstimate('4k', 81.2)).toEqual({ min: 9, max: 33, perMinute: false })
  for (const duration of [undefined, NaN, Infinity, -1, 0, 3601])
    expect(researchVideoExportEstimate('4k', duration)).toEqual({
      min: 6,
      max: 24,
      perMinute: true
    })
  expect(researchVideoExportEstimate('720p', 1)).toEqual({ min: 1, max: 2, perMinute: false })
})

it('leaves a progressing high-resolution render time beyond its planning estimate', () => {
  expect(researchVideoExportTimeout('720p', 81.2)).toBe(3_600_000)
  expect(researchVideoExportTimeout('4k', 300)).toBe(240 * 60_000)
  expect(researchVideoResolutionSchema.safeParse('8k').success).toBe(false)
})
