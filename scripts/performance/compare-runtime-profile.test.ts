/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { describe, expect, it } from 'vitest'
import { compareRuntimeProfiles, parseArguments } from './compare-runtime-profile.mjs'

const summary = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 4,
  platform: 'darwin',
  architecture: 'arm64',
  electronVersion: '43.7.5',
  incompleteSampleCount: 0,
  timings: {
    'first-startup-ready': { median: 1_000, p95: 1_100 },
    'open-science:startup-imports': { median: 500, p95: 550 }
  },
  ...overrides
})

describe('runtime profile comparison', () => {
  it('passes selected timings within the explicit regression budget', () => {
    const result = compareRuntimeProfiles({
      baseline: summary(),
      candidate: summary({
        timings: {
          'first-startup-ready': { median: 1_100, p95: 1_200 },
          'open-science:startup-imports': { median: 525, p95: 575 }
        }
      }),
      metrics: ['first-startup-ready', 'open-science:startup-imports'],
      maxRelativeRegression: 0.2
    })

    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('fails missing metrics and regressions instead of comparing an accidental intersection', () => {
    const result = compareRuntimeProfiles({
      baseline: summary(),
      candidate: summary({
        timings: { 'first-startup-ready': { median: 1_300, p95: 1_100 } },
        incompleteSampleCount: 1
      }),
      metrics: ['first-startup-ready', 'open-science:startup-imports'],
      maxRelativeRegression: 0.2
    })

    expect(result.ok).toBe(false)
    expect(result.incompleteSamples).toEqual([['candidate', 1]])
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'first-startup-ready',
          field: 'median',
          reason: 'regression'
        }),
        expect.objectContaining({ name: 'open-science:startup-imports', reason: 'missing-metric' })
      ])
    )
  })

  it('rejects metadata mismatches and requires explicit metrics at the CLI boundary', () => {
    expect(
      compareRuntimeProfiles({
        baseline: summary(),
        candidate: summary({ platform: 'win32' }),
        metrics: ['first-startup-ready'],
        maxRelativeRegression: 0.2
      }).ok
    ).toBe(false)
    expect(() => parseArguments(['baseline.json', 'candidate.json'])).toThrow(
      'At least one --metric is required'
    )
    expect(
      parseArguments([
        'baseline.json',
        'candidate.json',
        '--metric=first-startup-ready,open-science:startup-imports',
        '--max-relative-regression=15',
        '--json'
      ])
    ).toMatchObject({
      metrics: ['first-startup-ready', 'open-science:startup-imports'],
      maxRelativeRegression: 0.15,
      json: true
    })
  })

  it('rejects missing or invalid comparison metadata', () => {
    const result = compareRuntimeProfiles({
      baseline: summary({ schemaVersion: undefined, electronVersion: '' }),
      candidate: summary({ schemaVersion: undefined, electronVersion: undefined }),
      metrics: ['first-startup-ready'],
      maxRelativeRegression: 0.2
    })

    expect(result.ok).toBe(false)
    expect(result.metadataMismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'schemaVersion', reason: 'invalid-metadata' }),
        expect.objectContaining({ key: 'electronVersion', reason: 'invalid-metadata' })
      ])
    )
  })
})
