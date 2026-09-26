#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectRepodata, isComplete } from './windows-arm64-conda-availability.mjs'

// Representative stable releases answer whether each supported minor line has an official ARM64
// Windows artifact. These are probe inputs, not product pins.
export const OFFICIAL_PYTHON_ARM64 = [
  { minor: '3.11', version: '3.11.9' },
  { minor: '3.12', version: '3.12.6' },
  { minor: '3.13', version: '3.13.15' }
].map(({ minor, version }) => ({
  minor,
  version,
  installer: `https://www.python.org/ftp/python/${version}/python-${version}-arm64.exe`,
  embeddable: `https://www.python.org/ftp/python/${version}/python-${version}-embed-arm64.zip`
}))

export const OFFICIAL_R_ARM64 = [
  { minor: '4.3', version: '4.3.3' },
  { minor: '4.4', version: '4.4.3' }
].map(({ minor, version }) => ({
  minor,
  version,
  installer: `https://www.r-project.org/nosvn/winutf8/aarch64/R-4/R-${version}-aarch64.exe`
}))

const head = async (url, fetchImpl) => {
  const response = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(120000) })
  return { available: response.ok, status: response.status }
}

export const probeOfficialArtifacts = async (fetchImpl = fetch) => {
  const python = Object.fromEntries(
    await Promise.all(
      OFFICIAL_PYTHON_ARM64.map(async (release) => [
        release.minor,
        {
          version: release.version,
          installer: await head(release.installer, fetchImpl),
          embeddable: await head(release.embeddable, fetchImpl)
        }
      ])
    )
  )
  const r = Object.fromEntries(
    await Promise.all(
      OFFICIAL_R_ARM64.map(async (release) => [
        release.minor,
        { version: release.version, installer: await head(release.installer, fetchImpl) }
      ])
    )
  )
  return { python, r }
}

const fetchJson = async (url, fetchImpl) => {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`repodata download failed: HTTP ${response.status}`)
  return response.json()
}

export const probeRuntimeAvailability = async (fetchImpl = fetch) => {
  const official = await probeOfficialArtifacts(fetchImpl)
  const [native, noarch] = await Promise.all([
    fetchJson('https://conda.anaconda.org/conda-forge/win-arm64/repodata.json', fetchImpl),
    fetchJson('https://conda.anaconda.org/conda-forge/noarch/repodata.json', fetchImpl)
  ])
  const conda = inspectRepodata(native, noarch)
  return {
    official,
    conda,
    conclusions: {
      officialPythonArm64: Object.values(official.python).every(
        (release) => release.installer.available && release.embeddable.available
      ),
      officialRArm64ByMinor: Object.fromEntries(
        Object.entries(official.r).map(([minor, release]) => [minor, release.installer.available])
      ),
      officialRArm64All: Object.values(official.r).every((release) => release.installer.available),
      condaNotebookFloorComplete: isComplete(conda)
    }
  }
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectExecution) {
  console.log(JSON.stringify(await probeRuntimeAvailability(), null, 2))
}
