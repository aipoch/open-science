import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Wsl2BashPreviewStatus } from '../../shared/wsl-setup'
import { matchesWsl2BashPreviewManifest } from '../../shared/wsl2-preview-manifest'

declare const __OPEN_SCIENCE_WSL2_BASH_PREVIEW__: boolean | undefined
declare const __OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__: boolean | undefined

type PreviewEvaluation = Readonly<{
  platform: NodeJS.Platform
  arch: string
  buildEnabled: boolean
  developmentEnabled: boolean
  packaged: boolean
  resourcesPath?: string
  appVersion?: string
}>

const packagedAssetsMatch = (resourcesPath: string, appVersion: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(resourcesPath, 'notebook-network-sandbox', 'wsl2', 'manifest.json'), 'utf8')
    )
    return matchesWsl2BashPreviewManifest(parsed, appVersion)
  } catch {
    return false
  }
}

export const evaluateWsl2BashPreview = (input: PreviewEvaluation): Wsl2BashPreviewStatus => {
  if (!input.buildEnabled) return { available: false, reason: 'build-disabled' }
  if (input.platform !== 'win32') return { available: false, reason: 'unsupported-platform' }
  if (input.arch !== 'x64') return { available: false, reason: 'unsupported-architecture' }
  if (!input.packaged) {
    return input.developmentEnabled
      ? { available: true, reason: 'available', development: true }
      : { available: false, reason: 'unpackaged-build' }
  }
  if (
    !input.resourcesPath ||
    !input.appVersion ||
    !packagedAssetsMatch(input.resourcesPath, input.appVersion)
  ) {
    return { available: false, reason: 'assets-unavailable' }
  }
  return { available: true, reason: 'available' }
}

// Vite replaces this boolean while building the main bundle. The release job can set
// OPEN_SCIENCE_BUILD_WSL2_BASH_PREVIEW=0 to produce a rollback build; no runtime environment
// variable, renderer override, remote flag, or persisted preference can reopen that build. The
// development switch is checked only for unpackaged Windows x64 processes and cannot bypass this
// build rollback or packaged asset certification.
export const WSL2_BASH_PREVIEW_BUILD_ENABLED =
  typeof __OPEN_SCIENCE_WSL2_BASH_PREVIEW__ === 'boolean'
    ? __OPEN_SCIENCE_WSL2_BASH_PREVIEW__
    : true

export const WSL2_BASH_DEVELOPMENT_PREVIEW_ENABLED =
  typeof __OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__ === 'boolean'
    ? __OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__
    : false

let currentStatus: Wsl2BashPreviewStatus = {
  available: false,
  reason: 'not-initialized'
}

export const initializeWsl2BashPreview = (
  input: Omit<PreviewEvaluation, 'buildEnabled' | 'developmentEnabled'>
): void => {
  currentStatus = evaluateWsl2BashPreview({
    ...input,
    buildEnabled: WSL2_BASH_PREVIEW_BUILD_ENABLED,
    developmentEnabled: WSL2_BASH_DEVELOPMENT_PREVIEW_ENABLED
  })
}

export const wsl2BashPreviewStatus = (): Wsl2BashPreviewStatus => currentStatus
