import { describe, expect, it } from 'vitest'

import { floorPackages, VERSIONS } from './stage-default-envs.mjs'
import {
  inspectRepodata,
  isComplete,
  REQUIRED_PYTHON_FLOOR,
  REQUIRED_PYTHON_VERSIONS,
  REQUIRED_R_FLOOR,
  REQUIRED_R_VERSIONS
} from './windows-arm64-conda-availability.mjs'

const repodata = (subdir: string, entries: string[][], modern = true): object => ({
  info: { subdir },
  packages: {},
  [modern ? 'packages.conda' : 'packages']: Object.fromEntries(
    entries.map(([name, version]) => [
      `${name}-${version}-build.${modern ? 'conda' : 'tar.bz2'}`,
      { name, version }
    ])
  )
})

describe('Windows ARM64 conda availability probe', () => {
  it('matches real patch versions and includes noarch floors across both archive formats', () => {
    const report = inspectRepodata(
      repodata(
        'win-arm64',
        [
          ['micromamba', '2.8.1'],
          ['python', '3.11.9'],
          ['python', '3.12.8'],
          ['python', '3.13.1'],
          ['matplotlib-base', '3.9.0'],
          ['r-base', '4.3.3'],
          ['r-base', '4.4.3'],
          ['r-jsonlite', '1.0']
        ],
        false
      ),
      repodata('noarch', [
        ['nomkl', '1.0'],
        ['r-biocmanager', '1.0'],
        ['r-ggplot2', '3.0']
      ])
    )
    expect(isComplete(report)).toBe(true)
    expect(report.python).toEqual({ '3.11': true, '3.12': true, '3.13': true })
  })

  it('does not confuse similarly named packages or a newer minor with the required interpreter', () => {
    const report = inspectRepodata(
      repodata('win-arm64', [
        ['micromamba', '2.8.1'],
        ['python', '3.14.0'],
        ['python-librt', '3.12.0']
      ]),
      repodata('noarch', [['nomkl', '1.0']])
    )
    expect(isComplete(report)).toBe(false)
    expect(report.python['3.12']).toBe(false)
    expect(report.pythonFloor.nomkl).toBe(true)
    expect(report.pythonFloor['matplotlib-base']).toBe(false)
  })

  it('rejects another architecture and malformed repodata instead of reporting missing packages', () => {
    expect(() => inspectRepodata(repodata('win-64', []), repodata('noarch', []))).toThrow(
      'win-arm64'
    )
    expect(() => inspectRepodata({}, {})).toThrow('repodata')
  })

  it('does not count removed packages', () => {
    const data = {
      ...repodata('win-arm64', [['micromamba', '2.8.1']]),
      removed: ['micromamba-2.8.1-build.conda']
    }
    expect(inspectRepodata(data, repodata('noarch', [])).micromamba).toBe(false)
  })

  it('keeps the dependency-free CI probe aligned with production staging requirements', () => {
    expect(REQUIRED_PYTHON_VERSIONS).toEqual(VERSIONS.python)
    expect(REQUIRED_R_VERSIONS).toEqual(VERSIONS.r)
    expect(['python=3.12', ...REQUIRED_PYTHON_FLOOR]).toEqual(floorPackages('python', '3.12'))
    expect(['r-base=4.4', ...REQUIRED_R_FLOOR]).toEqual(floorPackages('r', '4.4'))
  })
})
