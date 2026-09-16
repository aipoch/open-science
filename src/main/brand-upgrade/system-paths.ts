import { basename, dirname, join, win32 } from 'node:path'

export const BRAND_APP_ID = 'com.aipoch.open-science'
export type MacBundleUpgradeDeps = {
  exists: (path: string) => boolean
  bundleId: (bundle: string) => string
  verify: (bundle: string) => void
  rename: (from: string, to: string) => void
  register: (bundle: string, previous: string[]) => void
  updateDock: (bundle: string, previous: string[]) => void
  relaunch: (executable: string) => void
}
export class NativeBrandUpgradeError extends Error {
  constructor(
    readonly step: string,
    readonly actualPath: string,
    cause: unknown
  ) {
    super(
      `Application brand upgrade failed during ${step}.\nCurrent application: ${actualPath}\n${cause instanceof Error ? cause.message : String(cause)}\nResolve the reported permissions, signature, or duplicate-installation issue, then reopen this application path to retry. If it was renamed, use this current path instead of an old shortcut.`,
      { cause }
    )
    this.name = 'NativeBrandUpgradeError'
  }
}

export const upgradeMacBundle = (executable: string, deps: MacBundleUpgradeDeps): boolean => {
  const bundle = dirname(dirname(dirname(executable)))
  const recognized = ['Open Science.app', 'OpenScience.app', 'Open-Science.app']
  if (!recognized.includes(basename(bundle))) return false
  const destination = join(dirname(bundle), 'Open-Science.app')
  const previous = recognized.slice(0, 2).map((name) => join(dirname(bundle), name))
  let actualPath = bundle
  let step = 'installation identity and duplicate checks'
  try {
    if (deps.bundleId(bundle) !== BRAND_APP_ID)
      throw new Error(`Unexpected bundle identity at ${bundle}`)
    if (bundle !== destination) {
      if (deps.exists(destination))
        throw new Error(
          `Two applications exist. Keep the intended installation:\n${bundle}\n${destination}`
        )
    } else {
      for (const old of previous) {
        if (deps.exists(old) && deps.bundleId(old) === BRAND_APP_ID)
          throw new Error(
            `Duplicate applications exist. Resolve the obsolete bundle:\n${old}\n${bundle}`
          )
      }
    }
    // A retry from the new path must pass the same identity and signature checks.
    step = 'signature verification'
    deps.verify(bundle)
    if (bundle !== destination) {
      step = 'bundle rename'
      deps.rename(bundle, destination)
      actualPath = destination
    }
    // After rename, stop on failure and report the real path. Rolling back here could invalidate
    // entries already registered by an earlier step. Reopening the new bundle retries these steps.
    step = 'application registration'
    deps.register(destination, previous)
    step = 'Dock update'
    deps.updateDock(destination, previous)
    if (bundle !== destination) {
      step = 'application relaunch'
      deps.relaunch(join(destination, 'Contents', 'MacOS', basename(executable)))
      return true
    }
    return false
  } catch (error) {
    throw new NativeBrandUpgradeError(step, actualPath, error)
  }
}

export type ShortcutDetails = { target: string; appUserModelId?: string; description?: string }
export type WindowsShortcutDeps = {
  exists: (path: string) => boolean
  reportUnreadable?: (path: string, error: unknown) => void
  read: (path: string) => ShortcutDetails
  update: (path: string, changes: { description: string }) => boolean
  rename: (from: string, to: string) => void
  notifyRename: (from: string, to: string) => void
}
export const upgradeWindowsShortcuts = (
  paths: string[],
  executable: string,
  deps: WindowsShortcutDeps
): void => {
  const target = win32.normalize(executable).toLowerCase()
  for (const path of paths) {
    if (!['Open Science.lnk', 'OpenScience.lnk', 'Open-Science.lnk'].includes(win32.basename(path)))
      continue
    let shortcut: ShortcutDetails
    try {
      shortcut = deps.read(path)
    } catch (error) {
      // An unreadable link has no verified ownership. Preserve it and inspect the remaining links.
      deps.reportUnreadable?.(path, error)
      continue
    }
    if (
      win32.normalize(shortcut.target).toLowerCase() !== target ||
      (shortcut.appUserModelId && shortcut.appUserModelId !== BRAND_APP_ID)
    )
      continue
    const destination = win32.join(win32.dirname(path), 'Open-Science.lnk')
    if (path !== destination && deps.exists(destination))
      throw new Error(
        `Application brand upgrade: duplicate shortcut at ${destination}. Resolve it before restarting.`
      )
    // Sparse update preserves arguments, working directory, and unexposed .lnk properties.
    if (!deps.update(path, { description: 'Open-Science' }))
      throw new Error(`Application brand upgrade: could not update shortcut ${path}`)
    if (path !== destination) {
      deps.rename(path, destination)
      deps.notifyRename(path, destination)
    }
  }
}

// Package-managed .desktop filenames stay stable. Repair user copies only when their executable
// belongs to this product, preserving options and all unrelated desktop-entry groups.
export const upgradeLinuxDesktopEntry = (contents: string, executable: string): string => {
  const lines = contents.split('\n')
  const start = lines.indexOf('[Desktop Entry]')
  if (start < 0) return contents
  const nextGroup = lines.findIndex((line, index) => index > start && /^\[/.test(line))
  const end = nextGroup < 0 ? lines.length : nextGroup
  const execIndex = lines.findIndex(
    (line, index) => index > start && index < end && line.startsWith('Exec=')
  )
  if (execIndex < 0) return contents
  const allowed = [
    executable,
    ...(executable === '/opt/Open-Science/open-science'
      ? ['/opt/Open Science/open-science', '/opt/OpenScience/open-science']
      : [])
  ]
  const value = lines[execIndex].slice(5)
  const owned = allowed
    .flatMap((path) => [path, `"${path}"`])
    .find((path) => value === path || value.startsWith(path + ' '))
  if (!owned) return contents
  const quoted = `"${executable.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')}"`
  lines[execIndex] = 'Exec=' + quoted + value.slice(owned.length)
  for (let i = start + 1; i < end; i++) {
    if (/^Name(?:\[[^\]]+\])?=(Open Science|OpenScience)$/.test(lines[i]))
      lines[i] = lines[i].replace(/=(?:Open Science|OpenScience)$/, '=Open-Science')
    // Only the installed deb executable proves ownership of these historical installation paths.
    // An AppImage may coexist with the deb and must not rewrite its references.
    if (executable === '/opt/Open-Science/open-science') {
      if (/^TryExec=\/opt\/(?:Open Science|OpenScience)\/open-science$/.test(lines[i]))
        lines[i] = 'TryExec=/opt/Open-Science/open-science'
      if (/^Path=\/opt\/(?:Open Science|OpenScience)(?:\/|$)/.test(lines[i]))
        lines[i] = lines[i].replace(
          /\/opt\/(?:Open Science|OpenScience)(?=\/|$)/,
          '/opt/Open-Science'
        )
      if (/^Icon=\/opt\/(?:Open Science|OpenScience)\//.test(lines[i]))
        lines[i] = lines[i].replace(/\/opt\/(?:Open Science|OpenScience)\//, '/opt/Open-Science/')
    }
  }
  return lines.join('\n')
}
