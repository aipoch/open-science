#!/usr/bin/env node

const REPODATA_URL = 'https://conda.anaconda.org/conda-forge/win-arm64/repodata.json'

export const REQUIRED_PYTHON_VERSIONS = ['3.11', '3.12', '3.13']
export const REQUIRED_R_VERSIONS = ['4.3', '4.4']
export const REQUIRED_PYTHON_FLOOR = ['matplotlib-base', 'nomkl']
export const REQUIRED_R_FLOOR = ['r-jsonlite', 'r-biocmanager', 'r-ggplot2']

const packageNames = (repodata) => [
  ...Object.keys(repodata?.packages ?? {}),
  ...Object.keys(repodata?.['packages.conda'] ?? {})
]

const hasPackage = (names, packageName) => names.some((name) => name.startsWith(`${packageName}-`))

const hasVersion = (names, packageName, version) =>
  names.some((name) => name.startsWith(`${packageName}-${version}-`))

export const inspectRepodata = (repodata) => {
  const names = packageNames(repodata)
  return {
    subdir: 'win-arm64',
    micromamba: hasPackage(names, 'micromamba'),
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
  process.argv[1] && process.argv[1].endsWith('windows-arm64-conda-availability.mjs')
if (isDirectExecution) {
  const response = await fetch(REPODATA_URL)
  if (!response.ok) throw new Error(`repodata download failed: HTTP ${response.status}`)
  const report = inspectRepodata(await response.json())
  console.log(JSON.stringify({ complete: isComplete(report), report }, null, 2))
  if (process.argv.includes('--strict') && !isComplete(report)) process.exitCode = 1
}
