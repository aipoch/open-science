import { basename, join, resolve, sep } from 'node:path'

import { app } from 'electron'

import { resolveBootstrapConfigRoot, resolveConfigRootOverride } from './storage/config-root'
import {
  DataLocationSelectionError,
  hasDataRootContent,
  selectDefaultDataRoot
} from './storage/data-location-selection'
export { DataLocationSelectionError } from './storage/data-location-selection'

// Fixed config root shared with the pre-Electron bootstrap. Never relocated with research data.
const resolveConfigRoot = (): string =>
  resolveBootstrapConfigRoot(() => app.getPath('home'), app.isPackaged)

// Legacy alias retained for source compatibility. New production call sites use resolveConfigRoot.
const resolveStorageRoot = resolveConfigRoot

// Visible, no-space data folder name. NO space: runtime/ holds conda/venv whose tools break on
// spaced paths. dev gets a suffix so it never shares data with a packaged build.
const dataFolderName = (): string => (app.isPackaged ? 'Open-Science' : 'Open-Science-DEV')
const legacyDataFolderName = (): string => (app.isPackaged ? 'OpenScience' : 'OpenScience-DEV')

// The data root the app derives from a user-picked (or default) parent directory: always
// `<parent>/<dataFolderName()>` for a new location. Verified existing roots are adopted directly
// by dataRootForPicked without appending a second product folder.
const dataRootForParent = (parent: string): string => join(parent, dataFolderName())

const defaultDataParent = (): string =>
  resolveConfigRootOverride(app.isPackaged) ?? app.getPath('home')

// Explicitly picked old and custom roots are validated by the migration/adoption owner. Preserve
// their exact location; selecting a root must not append a second brand directory.
const dataRootForPicked = (picked: string): string => {
  const resolved = resolve(picked)
  const name = basename(resolved)
  const folder = dataFolderName()
  const isDataFolder = [folder, legacyDataFolderName()].some((candidate) =>
    process.platform === 'win32'
      ? name.toLowerCase() === candidate.toLowerCase()
      : name === candidate
  )
  if (isDataFolder || hasDataRootContent(resolved)) return resolved
  const candidates = [join(resolved, folder), join(resolved, legacyDataFolderName())].filter(
    hasDataRootContent
  )
  if (candidates.length > 1)
    throw new DataLocationSelectionError(
      `Multiple data locations exist. Select the exact data folder:\n${candidates.join('\n')}`
    )
  return candidates[0] ?? join(resolved, folder)
}

// A saved location is authoritative. Without one, only actual data identifies a prior location;
// interrupted migration targets cannot become the live root by inference.
const computeDefaultDataRoot = (existingInstallation?: boolean): string => {
  const homeDefault = dataRootForParent(defaultDataParent())
  if (configuredDataRoot) return homeDefault
  return selectDefaultDataRoot(
    resolveConfigRoot(),
    defaultDataParent(),
    app.isPackaged,
    existingInstallation
  )
}

// Path equality that respects the platform filesystem: case-insensitive on Windows (NTFS paths are
// case-insensitive), exact elsewhere. Used for the isDefault check and the same/inside-folder
// guards so a differently-cased path to the SAME folder on Windows isn't mistaken for a different
// location — which would drop the "default location" tag, or let a migration target slip past the
// "outside the current data folder" guard.
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

// True when `child` is `parent` itself or nested inside it (both resolved/absolute), using the same
// platform-aware casing as samePath so a nested target isn't missed on Windows.
const isPathInsideOrEqual = (parent: string, child: string): boolean => {
  if (samePath(parent, child)) return true
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`
  return process.platform === 'win32'
    ? child.toLowerCase().startsWith(prefix.toLowerCase())
    : child.startsWith(prefix)
}

// Relocatable data root. Cached once at startup from settings (a change requires a restart), so this
// stays a synchronous pure getter for every downstream consumer.
let cachedDataRoot: string | undefined
let configuredDataRoot: string | undefined

const initDataRoot = (
  settingsDataRoot: string | undefined,
  existingInstallation?: boolean
): void => {
  cachedDataRoot = undefined
  configuredDataRoot = settingsDataRoot && settingsDataRoot.trim() ? settingsDataRoot : undefined
  cachedDataRoot = configuredDataRoot ?? computeDefaultDataRoot(existingInstallation)
}

// Before initDataRoot has run (early callers, tests), fall back to computeDefaultDataRoot()
// directly rather than exposing an uninitialized/undefined root.
const resolveDataRoot = (): string => cachedDataRoot ?? computeDefaultDataRoot()

export {
  resolveStorageRoot,
  resolveConfigRoot,
  resolveDataRoot,
  initDataRoot,
  dataFolderName,
  dataRootForParent,
  dataRootForPicked,
  computeDefaultDataRoot,
  defaultDataParent,
  samePath,
  isPathInsideOrEqual,
  hasDataRootContent
}
