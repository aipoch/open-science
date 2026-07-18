import { existsSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import { app } from 'electron'

import {
  DEV_SESSION_DIR_NAME,
  PROD_SESSION_DIR_NAME,
  getSessionPersistenceDir
} from './session-persistence/repository'
import { hasPendingMigrationMarker } from './storage/migration-marker'

// Fixed, dev-aware config root (DB, sessions, claude, skills, settings live here). Never relocated.
// A development-only absolute override supports truly isolated onboarding previews without changing
// HOME — changing HOME breaks the macOS default-keychain lookup and can trigger a dangerous "restore
// default keychain" dialog. Packaged builds always ignore the override.
const resolveStorageRoot = (): string => {
  const previewRoot = process.env.OPEN_SCIENCE_STORAGE_ROOT?.trim()

  if (!app.isPackaged && previewRoot) {
    if (!isAbsolute(previewRoot)) {
      throw new Error('OPEN_SCIENCE_STORAGE_ROOT must be an absolute path.')
    }

    return normalize(previewRoot)
  }

  return getSessionPersistenceDir(
    app.getPath('home'),
    app.isPackaged ? PROD_SESSION_DIR_NAME : DEV_SESSION_DIR_NAME
  )
}

// Alias for call-site clarity now that a second (data) root exists.
const resolveConfigRoot = resolveStorageRoot

// Visible, no-space data folder name. NO space: runtime/ holds conda/venv whose tools break on
// spaced paths. dev gets a suffix so it never shares data with a packaged build.
const dataFolderName = (): string => (app.isPackaged ? 'OpenScience' : 'OpenScience-DEV')

// The data root the app derives from a user-picked (or default) parent directory: always
// `<parent>/<dataFolderName()>`. The app never lets the user point directly at a data root - only
// at its parent - so this join is the single source of truth for the final path.
const dataRootForParent = (parent: string): string => join(parent, dataFolderName())

// Converts a user-PICKED directory into the data root. Normally appends the data folder name
// (`<picked>/OpenScience`), but when the user navigated INTO and selected the OpenScience folder
// itself (its basename already equals the data folder name), it is used as-is. Without this,
// picking the existing/default data folder would derive `<picked>/OpenScience/OpenScience` — a
// doubled, non-existent path that reports "data folder not found" on the next launch. The name
// match is case-insensitive on Windows (its filesystem is), so `...\openscience` is still
// recognized as the data folder rather than doubled.
const dataRootForPicked = (picked: string): string => {
  const resolved = resolve(picked)
  const name = basename(resolved)
  const folder = dataFolderName()
  const isDataFolder =
    process.platform === 'win32' ? name.toLowerCase() === folder.toLowerCase() : name === folder
  return isDataFolder ? resolved : join(resolved, folder)
}

// Top-level dirs that mark a config root as an existing (pre-§20) install with USER data still
// living there. Mirrors migration-service's MIGRATED_DIRS (NOT DATA_ROOT_DIRS): runtime/ is
// excluded because it is a rebuildable environment, not user data, and it is left behind after a
// relocation — including it would keep the legacy fallback "stuck" on the config root forever once
// a user had already moved their real data away. Kept as its own list (rather than imported) to
// avoid an import cycle with migration-service.
const LEGACY_DATA_MARKERS = ['artifacts', 'notebooks', 'uploads']

// Default data root for a fresh install is `~/OpenScience` (dev `~/OpenScience-DEV`). A legacy
// install - config root already holds data and never got an OpenScience subdir - keeps its data
// where it is instead of silently splitting an existing user's data across two locations. But this
// legacy fallback applies ONLY while no modern data folder exists yet: once `<home>/OpenScience`
// has been created (by a migration/relocation), it is the canonical default. Without that guard, a
// leftover legacy dir in the config root (e.g. old artifacts/ never cleaned up) would keep masking
// the real, in-use data root, so the app would report itself "not on the default" forever and
// "return to default" would aim at the wrong place.
const computeDefaultDataRoot = (): string => {
  const configRoot = resolveConfigRoot()
  const homeDefault = dataRootForParent(app.getPath('home'))
  // A marker-bearing homeDefault is a half-copied/uncommitted staging dir, NOT the committed default:
  // treat it as "not there yet" so a crashed or in-flight migration can't fool the legacy fallback into
  // thinking the modern data folder already exists (which would split a legacy user's data).
  const homeDefaultIsCommitted = existsSync(homeDefault) && !hasPendingMigrationMarker(homeDefault)
  const isLegacyInstall =
    LEGACY_DATA_MARKERS.some((dir) => existsSync(join(configRoot, dir))) &&
    !existsSync(join(configRoot, dataFolderName())) &&
    !homeDefaultIsCommitted

  return isLegacyInstall ? configRoot : homeDefault
}

// The parent directory whose derived data root is the default location. Feeding this back through
// the parent-based relocation flow (inspect/migrate) reproduces the default `<home>/OpenScience`
// exactly, which is how Settings offers a one-click "return to default" from a custom root. The
// only default that is NOT `<parent>/dataFolderName()` is an untouched legacy install (default =
// config root), and that case never reaches the reset UI — it is already the default, so no reset
// is offered.
const defaultDataParent = (): string => app.getPath('home')

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

const initDataRoot = (settingsDataRoot: string | undefined): void => {
  cachedDataRoot =
    settingsDataRoot && settingsDataRoot.trim() ? settingsDataRoot : computeDefaultDataRoot()
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
  isPathInsideOrEqual
}
