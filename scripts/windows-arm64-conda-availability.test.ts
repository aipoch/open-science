import { describe, expect, it } from 'vitest'

import { inspectRepodata, isComplete } from './windows-arm64-conda-availability.mjs'

describe('Windows ARM64 conda availability probe', () => {
  it('inspects both legacy tar.bz2 and .conda repodata entries', () => {
    const report = inspectRepodata({
      packages: {
        'micromamba-2.9.0-0.tar.bz2': {},
        'python-3.12-hash.tar.bz2': {}
      },
      'packages.conda': {
        'python-3.11-hash.conda': {},
        'python-3.13-hash.conda': {},
        'matplotlib-base-3.9.0-hash.conda': {},
        'nomkl-1.0-hash.conda': {},
        'r-base-4.3-hash.conda': {},
        'r-base-4.4-hash.conda': {},
        'r-jsonlite-1.0-hash.conda': {},
        'r-biocmanager-1.0-hash.conda': {},
        'r-ggplot2-3.0-hash.conda': {}
      }
    })

    expect(isComplete(report)).toBe(true)
    expect(report.python).toEqual({ '3.11': true, '3.12': true, '3.13': true })
    expect(report.r).toEqual({ '4.3': true, '4.4': true })
  })

  it('fails closed when the target channel has only a partial platform bootstrap', () => {
    const report = inspectRepodata({
      'packages.conda': {
        'micromamba-2.9.0-0.conda': {},
        'python-3.14.0-hash.conda': {}
      }
    })

    expect(isComplete(report)).toBe(false)
    expect(report.micromamba).toBe(true)
    expect(report.python['3.12']).toBe(false)
    expect(report.r['4.4']).toBe(false)
  })
})
