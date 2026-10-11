import { resolveMicromamba, type MicromambaDeps } from '@aipoch/environment'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeMetadataIfConfigured } from '../runtime-metadata'
import { APP } from '../../shared/app-config'
import type { BundleDirDeps } from '@aipoch/environment'
// Resolves the packaged default-env bundle directory (per-pack manifest + self-contained
// `<language>-<version>.tar.zst` archives, produced by scripts/stage-default-envs.mjs). Mirrors
// resolveLoopScript: env override →
// app.asar.unpacked (resources/** ships unpacked) → resourcesPath → dev source tree. Returns undefined
// when no bundle exists on disk, so the caller can try the CDN adapter.
export const resolveBundleDir = (deps: BundleDirDeps = {}): string | undefined => {
  const override = deps.override ?? process.env.OPEN_SCIENCE_ENV_BUNDLE_DIR
  if (override) return existsSync(override) ? override : undefined

  const resourcesPath = deps.resourcesPath ?? runtimeMetadataIfConfigured()?.resourcesPath
  const candidates = [
    resourcesPath && join(resourcesPath, 'app.asar.unpacked', 'resources', 'default-envs'),
    resourcesPath && join(resourcesPath, 'resources', 'default-envs'),
    join(__dirname, '../../resources/default-envs'),
    join(__dirname, '../../../resources/default-envs')
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find((candidate) => existsSync(candidate))
}

export const DEFAULT_RUNTIME_CDN_BASE = APP.cdnBaseUrl
export const resolveRuntimeCdnBase = (override?: string): string =>
  (override ?? process.env.OPEN_SCIENCE_ENV_CDN_BASE ?? DEFAULT_RUNTIME_CDN_BASE).replace(
    /\/+$/,
    ''
  )

export const resolveNotebookMicromamba = (deps: MicromambaDeps = {}): string | undefined =>
  resolveMicromamba({
    ...deps,
    resourcesPath: deps.resourcesPath ?? runtimeMetadataIfConfigured()?.resourcesPath
  })
