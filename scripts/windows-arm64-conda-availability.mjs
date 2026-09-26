#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPODATA_URL = 'https://conda.anaconda.org/conda-forge/win-arm64/repodata.json'

export const REQUIRED_PYTHON_VERSIONS = ['3.11', '3.12', '3.13']
export const REQUIRED_R_VERSIONS = ['4.3', '4.4']
export const REQUIRED_PYTHON_FLOOR = ['matplotlib-base', 'nomkl']
export const REQUIRED_R_FLOOR = ['r-jsonlite', 'r-biocmanager', 'r-ggplot2']

const records = (repodata, expectedSubdir) => {
  if (repodata?.info?.subdir !== expectedSubdir || !repodata.packages) {
    throw new Error(`Expected valid ${expectedSubdir} repodata`)
  }
  const removed = new Set(repodata.removed ?? [])
  return Object.entries({ ...repodata.packages, ...repodata['packages.conda'] })
    .filter(([file]) => !removed.has(file))
    .map(([, record]) => record)
}

const hasPackage = (packages, name) => packages.some((record) => record.name === name)

const hasVersion = (packages, name, version) =>
  packages.some(
    (record) =>
      record.name === name &&
      (record.version === version || record.version.startsWith(`${version}.`))
  )

export const inspectRepodata = (repodata, noarch) => {
  const native = records(repodata, 'win-arm64')
  const names = [...native, ...records(noarch, 'noarch')]
  return {
    subdir: 'win-arm64',
    micromamba: hasPackage(native, 'micromamba'),
    python: Object.fromEntries(
      REQUIRED_PYTHON_VERSIONS.map((version) => [version, hasVersion(names, 'python', version)])
    ),
    pythonFloor: Object.fromEntries(
      REQUIRED_PYTHON_FLOOR.map((packageName) => [packageName, hasPackage(names, packageName)])
    ),
    r: Object.fromEntries(
      REQUIRED_R_VERSIONS.map((version) => [version, hasVersion(names, 'r-base', version)])
    ),
    rFloor: Object.fromEntries(
      REQUIRED_R_FLOOR.map((packageName) => [packageName, hasPackage(names, packageName)])
    )
  }
}

export const isComplete = (report) =>
  report.micromamba &&
  Object.values(report.python).every(Boolean) &&
  Object.values(report.pythonFloor).every(Boolean) &&
  Object.values(report.r).every(Boolean) &&
  Object.values(report.rFloor).every(Boolean)

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectExecution) {
  const inputs = await Promise.all(
    [REPODATA_URL, REPODATA_URL.replace('/win-arm64/', '/noarch/')].map(async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!response.ok) throw new Error(`repodata download failed: HTTP ${response.status}`)
      return response.json()
    })
  )
  const report = inspectRepodata(...inputs)
  console.log(
    JSON.stringify(
      { packageAvailabilityComplete: isComplete(report), dependencySolve: 'not-tested', report },
      null,
      2
    )
  )
  if (process.argv.includes('--strict') && !isComplete(report)) process.exitCode = 1
}
