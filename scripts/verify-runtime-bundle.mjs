#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { pathToFileURL } from 'node:url'

import { VERSIONS, packArchiveFile, packId, readDefaultEnvVersion } from './stage-default-envs.mjs'

export const DEFAULT_CDN_BASE = 'https://statics.aipoch.com/open-science'

export const runtimeManifestUrl = (cdnBase, envVersion, subdir) =>
  `${cdnBase.replace(/\/+$/, '')}/runtime-bundle/${envVersion}/${subdir}/manifest.json`

export const validatePublishedManifest = (manifest, envVersion, subdir) => {
  if (!manifest || manifest.schema !== 1) throw new Error('manifest schema must be 1')
  if (manifest.envVersion !== envVersion) {
    throw new Error(`manifest envVersion ${manifest.envVersion} does not match ${envVersion}`)
  }
  if (manifest.subdir !== subdir) {
    throw new Error(`manifest subdir ${manifest.subdir} does not match ${subdir}`)
  }
  for (const [language, versions] of Object.entries(VERSIONS)) {
    for (const version of versions) {
      const id = packId(language, version)
      const entry = manifest.packs?.[id]
      if (!entry) throw new Error(`manifest is missing ${id}`)
      if (
        entry.language !== language ||
        entry.version !== version ||
        entry.file !== packArchiveFile(language, version)
      ) {
        throw new Error(`manifest has an invalid canonical entry for ${id}`)
      }
      if (
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isInteger(entry.size) ||
        entry.size <= 0
      ) {
        throw new Error(`manifest has invalid integrity metadata for ${id}`)
      }
    }
  }
}

export const verifyRuntimeBundle = async (cdnBase, envVersion, subdirs, fetchImpl = fetch) => {
  for (const subdir of subdirs) {
    const url = runtimeManifestUrl(cdnBase, envVersion, subdir)
    const response = await fetchImpl(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
    const manifest = await response.json()
    validatePublishedManifest(manifest, envVersion, subdir)
    console.log(`[runtime-bundle] verified ${url}`)
  }
}

const main = async () => {
  const subdirs = process.argv.slice(2)
  if (subdirs.length === 0) {
    throw new Error('usage: node scripts/verify-runtime-bundle.mjs <subdir> [subdir...]')
  }
  await verifyRuntimeBundle(
    process.env.OPEN_SCIENCE_ENV_CDN_BASE || DEFAULT_CDN_BASE,
    readDefaultEnvVersion(),
    subdirs
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[runtime-bundle] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
