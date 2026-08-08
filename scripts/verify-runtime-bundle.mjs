#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { VERSIONS, packArchiveFile, packId, readDefaultEnvVersion } from './stage-default-envs.mjs'

export const DEFAULT_CDN_BASE = 'https://statics.aipoch.com/open-science'
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_RETRY_DELAY_MS = 1000

const TRANSIENT_HTTP_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504])

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

export const verifyRuntimeBundle = async (
  cdnBase,
  envVersion,
  subdirs,
  {
    fetchImpl = fetch,
    sleepImpl = sleep,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS
  } = {}
) => {
  for (const subdir of subdirs) {
    const url = runtimeManifestUrl(cdnBase, envVersion, subdir)
    let response
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await fetchImpl(url, { cache: 'no-store' })
      } catch (error) {
        if (attempt === maxAttempts) {
          throw new Error(
            `${url} request failed after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}`
          )
        }
        console.warn(`[runtime-bundle] ${url} request failed; retrying (${attempt}/${maxAttempts})`)
        await sleepImpl(retryDelayMs * attempt)
        continue
      }

      if (response.ok) break
      if (!TRANSIENT_HTTP_STATUSES.has(response.status) || attempt === maxAttempts) {
        throw new Error(`${url} returned HTTP ${response.status} after ${attempt} attempt(s)`)
      }
      console.warn(
        `[runtime-bundle] ${url} returned HTTP ${response.status}; retrying (${attempt}/${maxAttempts})`
      )
      await sleepImpl(retryDelayMs * attempt)
    }

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
